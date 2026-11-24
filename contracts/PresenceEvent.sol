// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PresenceCaseWriter} from "./PresenceCaseWriter.sol";

/// @notice Kleros Court v1 arbitrator (KlerosLiquid, ERC-792), e.g. 0x988b3A538b618C7A603e1c11Ab82Cd16dbE28069 on
/// Ethereum mainnet. Extra data = abi.encode(uint256 subcourtID, uint256 minJurors). Anyone can move a case on with
/// `passPeriod(disputeID)` and deliver the ruling with `executeRuling(disputeID)`.
interface IKlerosLiquid {
    function arbitrationCost(bytes calldata extraData) external view returns (uint256 cost);
    function appealCost(uint256 disputeID, bytes calldata extraData) external view returns (uint256 cost);
    function appealPeriod(uint256 disputeID) external view returns (uint256 start, uint256 end);
    function currentRuling(uint256 disputeID) external view returns (uint256 ruling);
}

/// @notice Kleros's general-purpose Dispute Resolver (ArbitrableProxy), e.g. 0x4b89e798b10478a839ea0abcf86c4b94a3c782a4
/// on Ethereum mainnet. It opens the case, takes evidence (`submitEvidence(localDisputeID, uri)`) and appeal
/// crowdfunding (`fundAppeal(localDisputeID, ruling)`) straight from each person's wallet, and records the final
/// ruling. Appeal money never passes through this contract.
interface IArbitrableProxy {
    function arbitrator() external view returns (IKlerosLiquid);
    function createDispute(bytes calldata arbitratorExtraData, string calldata metaevidenceURI, uint256 numberOfRulingOptions)
        external
        payable
        returns (uint256 arbitratorDisputeID);
    function externalIDtoLocalID(uint256 arbitratorDisputeID) external view returns (uint256 localDisputeID);
    function disputes(uint256 localDisputeID)
        external
        view
        returns (bytes memory arbitratorExtraData, bool isRuled, uint256 ruling, uint256 disputeIDOnArbitratorSide);
    function getMultipliers()
        external
        view
        returns (uint256 winnerStakeMultiplier, uint256 loserStakeMultiplier, uint256 loserAppealPeriodMultiplier, uint256 denominator);
}

interface IERC20Min {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @title PresenceEvent: Proof of Presence, one event
/// @notice Refundable "commitment" deposits for a real-world event, with the attendance list open to challenge
/// in Kleros Court. Every event is a minimal clone (EIP-1167) of one implementation, created by `PresenceFactory`
/// for whoever calls it (the organiser). The code cannot be changed by anyone: no proxy admin, no upgrade.
///
/// Flow
///  1. Deposit: from creation until `eventEnd`, anyone sends exactly `depositAmount` (ETH, or the event's ERC-20
///     token through `deposit()` after an approval) and is registered as a staker in the same transaction. Walk-ins
///     can still deposit while the event is running. A wrong amount, a second deposit from the same wallet, a full
///     event or a late payment is refused, so the money stays in the sender's wallet.
///  2. Curation: until the list is closed, the organiser can turn a staker away with `reject`, which gives back
///     exactly their deposit (bots, wrong audience, someone who cancelled).
///  3. Attendance: from `eventEnd` until `claimDeadline`, the organiser posts the stakers who showed up
///     (`postAttendance`, in several batches if needed) and closes the list, which opens the challenge window.
///  4. Challenge (`challengePeriod`, 1 day by default): a staker left off the list who says they attended calls
///     `challenge`, paying the Kleros arbitration cost as a challenge deposit.
///  5. Match (`matchPeriod` from each challenge, 1 day by default): anyone who disagrees (usually the organiser)
///     pays the same with `matchChallenge`; the Kleros fee comes out of the two deposits and a Kleros case opens,
///     with a case description this contract writes itself (event, wallet, organiser, deposit; `caseMetaEvidence`).
///     If nobody matches, the challenger counts as attended and gets their challenge deposit back.
///     The final ruling decides: 1 = attended (the challenger joins the list and gets what is left of both deposits),
///     2 = did not attend (the matcher gets it), 0 = refused to arbitrate (off the list, the rest split in half).
///  6. Payout: once the challenge window is over and no challenge waits for a match, anyone calls
///     `releasePayouts`. The staked pool (deposit x stakers: no-shows lose theirs) is split into equal shares, one per
///     attendee plus one set aside per open Kleros case, so a dispute never holds anyone else's money. A case settled
///     later either gives its share to the challenger (attended) or splits it equally among the attendees and the
///     cases still open, so everyone on the final list receives the same total in any settlement order.
///  7. Money is paid on a pull basis: each person calls `withdraw(to)`, or anyone calls `distribute(accounts)` to push
///     it to many wallets at once (a wallet that cannot receive it keeps it claimable). Nothing is ever lost to a
///     wallet that refuses a payment.
///
/// Safety nets
///  - `cancel` (organiser, before the list is closed and before `claimDeadline`): every staker takes back their deposit.
///  - If the organiser never closes the list by `claimDeadline`, every staker can take back their own deposit.
///  - `recoverSpare` only moves money nobody is owed (tokens or ETH sent here by mistake, rounding dust): never a
///    deposit, a share, challenge money or anything waiting to be withdrawn.
///  - Ownership moves in two steps (`transferOwnership`, then `acceptOwnership`).
contract PresenceEvent {
    // ------------------------------------------------------------------ errors
    error AlreadyInitialized();
    error NotOwner();
    error NotPendingOwner();
    error NotOpen();
    error NotListed();
    error ZeroAddress();
    error BadConfig(string field);
    error TooLate();
    error TooEarly();
    error Reentrancy();
    error AlreadyStaker(address account);
    error WasRejected(address account);
    error EventFull(uint256 capacity);
    error NotAStaker(address account);
    error DuplicateAttendee(address account);
    error NoAttendees();
    error NothingToWithdraw();
    error TransferFailed(address to, uint256 amount);
    error WrongAmount(uint256 required, uint256 sent);
    error TokenEvent();
    error AlreadyAttending(address account);
    error AlreadyChallenged(address account);
    error NoChallenge(address account);
    error WrongChallengeState(address account);
    error ArbitrationCostTooHigh(uint256 cost, uint256 available);
    error NotRuled(address account);
    error ChallengesPending(uint256 count);
    error OnlyNumberedRulings();
    error InDispute(address staker);
    error NotAppealable(address staker);
    error NotEnoughGas();
    error SpareTooLow(uint256 spare);
    error BadTemplate();

    // ------------------------------------------------------------------ events
    event EventCreated(address indexed organiser, address indexed token, uint256 depositAmount, uint256 eventStart, uint256 eventEnd);
    event Deposited(address indexed staker, uint256 amount);
    event Rejected(address indexed staker, uint256 refunded);
    event AttendeeAdded(address indexed attendee);
    event ListClosed(uint256 attendees, uint256 challengeEndsAt);
    event Challenged(address indexed staker, uint256 deposit, uint256 matchEndsAt);
    event ChallengeMatched(address indexed staker, address indexed matcher, uint256 arbitratorDisputeID, uint256 localDisputeID);
    event ChallengeResolved(address indexed staker, bool attended, uint256 ruling);
    event PayoutsReleased(uint256 stakers, uint256 attendees, uint256 openCases, uint256 share);
    event HeldShareSplit(address indexed staker, uint256 attendees, uint256 openCases, uint256 each);
    event Cancelled(uint256 stakers);
    /// @notice Money reached `to` (`eth` = paid in ETH; otherwise in the event's token).
    event Paid(address indexed account, address indexed to, uint256 amount, bool eth);
    /// @notice A pushed payment could not be delivered: it stays claimable with `withdraw`.
    event PaymentFailed(address indexed account, uint256 amount, bool eth);
    event SpareRecovered(address indexed asset, address indexed to, uint256 amount);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    // ------------------------------------------------------------------ types
    enum Phase {
        Open, // deposits until eventEnd, then the attendance list is being posted
        Listed, // list closed: challenge window, then waiting for payout
        Finalized, // payouts released
        Cancelled // event called off: stakers take back their deposit
    }

    enum Status {
        None,
        Staker,
        Rejected, // turned away and refunded: cannot deposit again
        Refunded // took the deposit back after a cancellation or a missed deadline
    }

    enum ChallengeState {
        None,
        Waiting, // challenger paid, waiting for a match
        Disputed, // matched: a Kleros case is open
        Resolved
    }

    struct Challenge {
        ChallengeState state;
        uint64 matchEndsAt;
        address matcher;
        address organiser; // the event's owner when the challenge was opened: named in the case description
        uint256 deposit; // ETH paid by each side
        uint256 arbitratorDisputeID; // Kleros's case number (court.kleros.io/cases/<id>)
        uint256 localDisputeID; // the case's number in the Dispute Resolver: evidence and appeals use it
        uint256 arbitrationPaid; // ETH spent on the Kleros fee
    }

    /// @notice What an organiser chooses when creating an event (`PresenceFactory.createEvent`).
    struct Config {
        string name; // shown to guests and jurors: 1 to 200 bytes, no quotes, backslashes or control characters
        string url; // the event page (e.g. Luma), optional: up to 300 bytes, same characters
        address token; // address(0) = native ETH; otherwise an ERC-20 without transfer fees
        uint256 depositAmount; // in wei, or in the token's smallest unit
        uint64 eventStart; // unix seconds
        uint64 eventEnd; // deposits are accepted until this time; the list can be posted from it
        uint64 claimDeadline; // at least 7 days after eventEnd: last moment to close the list
        uint32 capacity; // maximum number of stakers at the same time; 0 = no limit
    }

    // ------------------------------------------------------------------ constants
    uint256 public constant RULING_ATTENDED = 1;
    uint256 public constant RULING_ABSENT = 2;
    uint256 public constant RULING_OPTIONS = 2;
    /// @notice Minimum time between the event's end and the deadline to close the list.
    uint256 public constant MIN_SETTLEMENT_WINDOW = 7 days;
    /// @notice Maximum time between the event's end and the deadline to close the list.
    uint256 public constant MAX_SETTLEMENT_WINDOW = 90 days;
    /// @notice An event must end within this long of its creation.
    uint256 public constant MAX_LEAD_TIME = 2 * 365 days;
    /// @notice Gas a pushed ETH payment may use in the recipient (enough for a Safe or a smart account).
    uint256 public constant PUSH_GAS_ETH = 40_000;
    /// @notice Gas a pushed token transfer may use.
    uint256 public constant PUSH_GAS_TOKEN = 120_000;
    uint256 public constant MAX_NAME = 200;
    uint256 public constant MAX_URL = 300;


    // ------------------------------------------------------------------ protocol settings (shared by every clone)
    /// @notice Kleros's Dispute Resolver: every event's challenges go there. Fixed in the implementation's code.
    IArbitrableProxy public immutable disputeResolver;
    /// @notice Kleros Court (KlerosLiquid), read from the Dispute Resolver.
    IKlerosLiquid public immutable arbitrator;
    uint256 public immutable challengePeriod;
    uint256 public immutable matchPeriod;
    /// @dev Contract whose code (after a STOP byte) holds abi.encode(extraData, policyURI).
    address private immutable _settingsStore;
    /// @notice Writes the case descriptions (holds the template).
    PresenceCaseWriter public immutable caseWriter;

    // ------------------------------------------------------------------ event settings
    address public factory;
    address public owner;
    address public pendingOwner;
    string public eventName;
    string public eventURL;
    address public token;
    string public tokenSymbol;
    uint8 public tokenDecimals;
    uint256 public depositAmount;
    uint64 public eventStart;
    uint64 public eventEnd;
    uint64 public claimDeadline;
    uint32 public capacity;

    // ------------------------------------------------------------------ state
    Phase public phase;
    mapping(address => Status) public status;
    address[] private _stakers;
    uint256 public stakerCount; // current stakers

    mapping(address => bool) public attended;
    address[] private _attendees;
    uint256 public attendeeCount;
    uint256 public challengeEndsAt;

    mapping(address => Challenge) public challenges;
    address[] private _challengers;
    uint256 public waitingChallenges; // waiting for a match
    uint256 public openCases; // matched, Kleros case not settled yet
    /// @notice ETH held for challenges (always ETH, whatever the event's token).
    uint256 public challengeEscrow;

    /// @notice What each attendee has earned in total since the payout (grows when a held share is split).
    uint256 public payoutShare;
    mapping(address => uint256) public sharePaid;
    uint256 public sharePaidTotal;

    /// @notice Money in the event's asset (refunds, failed pushes) waiting for `withdraw`.
    mapping(address => uint256) public owed;
    uint256 public owedTotal;
    /// @notice ETH (challenge money) waiting for `withdraw`.
    mapping(address => uint256) public owedEth;
    uint256 public owedEthTotal;

    uint256 private _locked;

    // ------------------------------------------------------------------ setup

    /// @param resolver Kleros's Dispute Resolver on this chain.
    /// @param extraData abi.encode(subcourtID, minJurors): e.g. General Court (0), 3 jurors.
    /// @param policyURI The attendance policy jurors apply ("/ipfs/Qm..."), also the template's fileURI.
    /// @param writer Writes each case's description from the template it holds (`PresenceCaseWriter`).
    constructor(
        IArbitrableProxy resolver,
        bytes memory extraData,
        string memory policyURI,
        PresenceCaseWriter writer,
        uint256 challengePeriod_,
        uint256 matchPeriod_
    ) {
        require(address(resolver) != address(0), ZeroAddress());
        IKlerosLiquid court = resolver.arbitrator(); // reverts if this is not a Dispute Resolver
        require(address(court) != address(0), ZeroAddress());
        require(challengePeriod_ >= 1 hours && challengePeriod_ <= 30 days, BadConfig("challengePeriod"));
        require(matchPeriod_ >= 1 hours && matchPeriod_ <= 30 days, BadConfig("matchPeriod"));
        require(bytes(policyURI).length > 0, BadConfig("policyURI"));
        require(address(writer).code.length > 0, BadTemplate());
        disputeResolver = resolver;
        arbitrator = court;
        challengePeriod = challengePeriod_;
        matchPeriod = matchPeriod_;
        _settingsStore = _storeData(abi.encode(extraData, policyURI));
        caseWriter = writer;
        // the implementation itself can never be used as an event
        factory = address(1);
        _locked = 1;
    }

    /// @notice Called once by the factory, in the transaction that creates the clone.
    function initialize(address organiser, Config calldata c) external {
        require(factory == address(0), AlreadyInitialized());
        require(organiser != address(0), ZeroAddress());
        require(c.depositAmount > 0, BadConfig("depositAmount"));
        require(c.eventEnd >= c.eventStart, BadConfig("eventEnd"));
        require(c.eventEnd > block.timestamp, BadConfig("eventEnd"));
        require(uint256(c.eventEnd) <= block.timestamp + MAX_LEAD_TIME, BadConfig("eventEnd"));
        require(uint256(c.claimDeadline) >= uint256(c.eventEnd) + MIN_SETTLEMENT_WINDOW, BadConfig("claimDeadline"));
        require(uint256(c.claimDeadline) <= uint256(c.eventEnd) + MAX_SETTLEMENT_WINDOW, BadConfig("claimDeadline"));
        require(bytes(c.name).length > 0 && bytes(c.name).length <= MAX_NAME && _jsonSafe(bytes(c.name)), BadConfig("name"));
        require(bytes(c.url).length <= MAX_URL && _jsonSafe(bytes(c.url)), BadConfig("url"));
        factory = msg.sender;
        owner = organiser;
        eventName = c.name;
        eventURL = c.url;
        depositAmount = c.depositAmount;
        eventStart = c.eventStart;
        eventEnd = c.eventEnd;
        claimDeadline = c.claimDeadline;
        capacity = c.capacity;
        if (c.token == address(0)) {
            tokenSymbol = "ETH";
            tokenDecimals = 18;
        } else {
            require(c.token.code.length > 0, BadConfig("token"));
            token = c.token;
            (tokenSymbol, tokenDecimals) = _tokenInfo(c.token);
        }
        _locked = 1;
        emit OwnershipTransferred(address(0), organiser);
        emit EventCreated(organiser, c.token, c.depositAmount, c.eventStart, c.eventEnd);
    }

    modifier onlyOwner() {
        require(msg.sender == owner, NotOwner());
        _;
    }

    modifier nonReentrant() {
        require(_locked == 1, Reentrancy());
        _locked = 2;
        _;
        _locked = 1;
    }

    // ------------------------------------------------------------------ deposits

    /// @notice ETH events: a plain transfer of exactly `depositAmount` is a deposit.
    receive() external payable {
        _deposit();
    }

    /// @notice Pay the deposit and become a staker. ETH events: send exactly `depositAmount`. Token events: approve
    /// this contract for `depositAmount` first and send no ETH.
    function deposit() external payable {
        _deposit();
    }

    function _deposit() private nonReentrant {
        require(phase == Phase.Open, NotOpen());
        require(block.timestamp < eventEnd, TooLate());
        Status st = status[msg.sender];
        require(st != Status.Staker, AlreadyStaker(msg.sender));
        require(st != Status.Rejected, WasRejected(msg.sender));
        require(capacity == 0 || stakerCount < capacity, EventFull(capacity));
        uint256 amount = depositAmount;
        address t = token;
        if (t == address(0)) {
            require(msg.value == amount, WrongAmount(amount, msg.value));
        } else {
            require(msg.value == 0, TokenEvent());
            uint256 before = IERC20Min(t).balanceOf(address(this));
            _callToken(t, abi.encodeCall(IERC20Min.transferFrom, (msg.sender, address(this), amount)), gasleft(), true);
            uint256 received = IERC20Min(t).balanceOf(address(this)) - before;
            require(received == amount, WrongAmount(amount, received)); // no fee-on-transfer tokens
        }
        status[msg.sender] = Status.Staker;
        if (st == Status.None) _stakers.push(msg.sender);
        stakerCount += 1;
        emit Deposited(msg.sender, amount);
    }

    // ------------------------------------------------------------------ curation (organiser)

    /// @notice Turn stakers away before the event starts: each gets exactly their deposit back (pushed, or kept
    /// claimable if their wallet refuses it) and cannot deposit again. Once the event has started, nobody can be
    /// turned away, so a guest who came cannot be removed from the pool (they can still be left off the list, and
    /// then challenge).
    function reject(address[] calldata wallets) external nonReentrant onlyOwner {
        require(phase == Phase.Open, NotOpen());
        require(block.timestamp < eventStart, TooLate());
        for (uint256 i; i < wallets.length; ++i) {
            address w = wallets[i];
            require(status[w] == Status.Staker, NotAStaker(w));
            require(!attended[w], AlreadyAttending(w));
            status[w] = Status.Rejected;
            stakerCount -= 1;
            emit Rejected(w, depositAmount);
            _push(w, depositAmount, false);
        }
    }

    // ------------------------------------------------------------------ attendance

    /// @notice Post stakers who showed up, in one or several batches, from `eventEnd` until `claimDeadline`.
    /// `close` = true closes the list (it cannot be empty) and opens the challenge window.
    function postAttendance(address[] calldata list, bool close) external nonReentrant onlyOwner {
        require(phase == Phase.Open, NotOpen());
        require(block.timestamp >= eventEnd, TooEarly());
        require(block.timestamp <= claimDeadline, TooLate());
        for (uint256 i; i < list.length; ++i) _addAttendee(list[i]);
        if (close) {
            require(attendeeCount > 0, NoAttendees());
            phase = Phase.Listed;
            challengeEndsAt = block.timestamp + challengePeriod;
            emit ListClosed(attendeeCount, challengeEndsAt);
        }
    }

    /// @notice During the challenge window, add stakers left off by mistake. A waiting (unmatched) challenge of
    /// theirs ends at once and its deposit goes back. A staker already in a Kleros case is for the jurors to decide.
    function addAttendees(address[] calldata list) external nonReentrant onlyOwner {
        require(phase == Phase.Listed, NotListed());
        require(block.timestamp <= challengeEndsAt, TooLate());
        for (uint256 i; i < list.length; ++i) {
            address a = list[i];
            Challenge storage c = challenges[a];
            require(c.state != ChallengeState.Disputed, InDispute(a));
            _addAttendee(a);
            if (c.state == ChallengeState.Waiting) {
                c.state = ChallengeState.Resolved;
                waitingChallenges -= 1;
                challengeEscrow -= c.deposit;
                emit ChallengeResolved(a, true, RULING_ATTENDED);
                _push(a, c.deposit, true);
            }
        }
    }

    // ------------------------------------------------------------------ challenges (Kleros)

    /// @notice A staker left off the list says they attended: pay `challengeDeposit()` in ETH (extra comes back).
    function challenge() external payable nonReentrant {
        require(phase == Phase.Listed, NotListed());
        require(block.timestamp <= challengeEndsAt, TooLate());
        require(status[msg.sender] == Status.Staker, NotAStaker(msg.sender));
        require(!attended[msg.sender], AlreadyAttending(msg.sender));
        Challenge storage c = challenges[msg.sender];
        require(c.state == ChallengeState.None, AlreadyChallenged(msg.sender));
        uint256 cost = challengeDeposit();
        require(msg.value >= cost, WrongAmount(cost, msg.value));
        c.state = ChallengeState.Waiting;
        c.deposit = cost;
        c.organiser = owner;
        c.matchEndsAt = uint64(block.timestamp + matchPeriod);
        _challengers.push(msg.sender);
        waitingChallenges += 1;
        challengeEscrow += cost;
        emit Challenged(msg.sender, cost, c.matchEndsAt);
        if (msg.value > cost) _push(msg.sender, msg.value - cost, true);
    }

    /// @notice Disagree with a challenge: pay the same deposit before its match window ends. This opens a Kleros
    /// case through the Dispute Resolver, with the description `caseMetaEvidence(staker)` (extra ETH comes back).
    function matchChallenge(address staker) external payable nonReentrant {
        require(phase == Phase.Listed, NotListed());
        Challenge storage c = challenges[staker];
        require(c.state != ChallengeState.None, NoChallenge(staker));
        require(c.state == ChallengeState.Waiting, WrongChallengeState(staker));
        require(block.timestamp <= c.matchEndsAt, TooLate());
        require(msg.value >= c.deposit, WrongAmount(c.deposit, msg.value));
        uint256 cost = challengeDeposit();
        require(cost <= 2 * c.deposit, ArbitrationCostTooHigh(cost, 2 * c.deposit));
        c.state = ChallengeState.Disputed;
        c.matcher = msg.sender;
        c.arbitrationPaid = cost;
        waitingChallenges -= 1;
        openCases += 1;
        challengeEscrow = challengeEscrow + c.deposit - cost;
        (, string memory uri) = caseMetaEvidence(staker);
        (bytes memory extraData,) = _settings();
        uint256 id = disputeResolver.createDispute{value: cost}(extraData, uri, RULING_OPTIONS);
        uint256 localID = disputeResolver.externalIDtoLocalID(id);
        c.arbitratorDisputeID = id;
        c.localDisputeID = localID;
        emit ChallengeMatched(staker, msg.sender, id, localID);
        if (msg.value > c.deposit) _push(msg.sender, msg.value - c.deposit, true);
    }

    /// @notice Settle a challenge: unmatched after its match window (counts as attended), or ruled by Kleros (final
    /// ruling, after appeals). Anyone can call it.
    function resolveChallenge(address staker) external nonReentrant {
        Challenge storage c = challenges[staker];
        require(c.state != ChallengeState.None, NoChallenge(staker));
        if (c.state == ChallengeState.Waiting) {
            require(block.timestamp > c.matchEndsAt, TooEarly());
            _acceptUnmatched(staker, c);
            return;
        }
        require(c.state == ChallengeState.Disputed, WrongChallengeState(staker));
        (, bool isRuled, uint256 ruling,) = disputeResolver.disputes(c.localDisputeID);
        require(isRuled, NotRuled(staker));
        require(ruling <= RULING_ABSENT, OnlyNumberedRulings());
        c.state = ChallengeState.Resolved;
        openCases -= 1;
        uint256 remaining = 2 * c.deposit - c.arbitrationPaid;
        challengeEscrow -= remaining;
        bool won = ruling == RULING_ATTENDED;
        emit ChallengeResolved(staker, won, ruling);
        if (won) {
            // before payout: joins the list. After payout: also joins, and is owed `payoutShare` like every attendee
            // (the share set aside for this case is exactly that much, so the totals stay the same).
            _addAttendee(staker);
        } else if (phase == Phase.Finalized) {
            // the share set aside for this case (= payoutShare) is split among attendees and the cases still open
            uint256 n = attendeeCount;
            uint256 each = payoutShare / (n + openCases); // n >= 1
            payoutShare += each;
            emit HeldShareSplit(staker, n, openCases, each);
        }
        if (won) {
            _push(staker, remaining, true);
        } else if (ruling == RULING_ABSENT) {
            _push(c.matcher, remaining, true);
        } else {
            _push(staker, remaining / 2, true);
            _push(c.matcher, remaining - remaining / 2, true);
        }
    }

    // ------------------------------------------------------------------ settlement

    /// @notice Split the pool once the challenge window is over. Pass the challengers whose match window ran out
    /// without a match (they are accepted first); no challenge may still be waiting for a match. One share is set
    /// aside for each open Kleros case. Anyone can call it. Attendees then `withdraw`, or anyone `distribute`s.
    function releasePayouts(address[] calldata expiredChallenges) external nonReentrant {
        require(phase == Phase.Listed, NotListed());
        require(block.timestamp > challengeEndsAt, TooEarly());
        for (uint256 i; i < expiredChallenges.length; ++i) {
            address s = expiredChallenges[i];
            Challenge storage c = challenges[s];
            if (c.state == ChallengeState.Waiting && block.timestamp > c.matchEndsAt) _acceptUnmatched(s, c);
        }
        require(waitingChallenges == 0, ChallengesPending(waitingChallenges));
        uint256 pool = depositAmount * stakerCount;
        uint256 share = pool / (attendeeCount + openCases); // attendeeCount >= 1
        payoutShare = share;
        phase = Phase.Finalized;
        emit PayoutsReleased(stakerCount, attendeeCount, openCases, share);
    }

    /// @notice The organiser calls the event off (before the list is closed): every staker takes their deposit back.
    function cancel() external nonReentrant onlyOwner {
        require(phase == Phase.Open, NotOpen());
        require(block.timestamp <= claimDeadline, TooLate());
        phase = Phase.Cancelled;
        emit Cancelled(stakerCount);
    }

    // ------------------------------------------------------------------ withdrawals

    /// @notice What `account` can withdraw now: in the event's asset (`amount`) and in ETH (`ethAmount`, challenge
    /// money). For an ETH event both are ETH.
    function claimable(address account) public view returns (uint256 amount, uint256 ethAmount) {
        amount = owed[account] + _poolPart(account);
        ethAmount = owedEth[account];
    }

    /// @notice Take everything you are owed, to any address. All the gas you send is forwarded.
    function withdraw(address to) external nonReentrant {
        require(to != address(0) && to != address(this), ZeroAddress());
        uint256 amount = _takePool(msg.sender);
        uint256 o = owed[msg.sender];
        if (o > 0) {
            owed[msg.sender] = 0;
            owedTotal -= o;
            amount += o;
        }
        uint256 ethAmount = owedEth[msg.sender];
        if (ethAmount > 0) {
            owedEth[msg.sender] = 0;
            owedEthTotal -= ethAmount;
        }
        require(amount > 0 || ethAmount > 0, NothingToWithdraw());
        if (amount > 0) {
            emit Paid(msg.sender, to, amount, token == address(0));
            if (token == address(0)) _sendEth(to, amount);
            else _callToken(token, abi.encodeCall(IERC20Min.transfer, (to, amount)), gasleft(), true);
        }
        if (ethAmount > 0) {
            emit Paid(msg.sender, to, ethAmount, true);
            _sendEth(to, ethAmount);
        }
    }

    /// @notice Push what each of `accounts` can withdraw to their own wallet (anyone can call it). A wallet that
    /// refuses the payment keeps it claimable.
    function distribute(address[] calldata accounts) external nonReentrant {
        for (uint256 i; i < accounts.length; ++i) {
            address a = accounts[i];
            uint256 amount = _takePool(a);
            uint256 o = owed[a];
            if (o > 0) {
                owed[a] = 0;
                owedTotal -= o;
                amount += o;
            }
            uint256 ethAmount = owedEth[a];
            if (ethAmount > 0) {
                owedEth[a] = 0;
                owedEthTotal -= ethAmount;
            }
            _push(a, amount, false);
            _push(a, ethAmount, true);
        }
    }

    // ------------------------------------------------------------------ spare money

    /// @notice Money in this contract that nobody is owed, per asset (`asset` = address(0) for ETH): for the event's
    /// own asset and for ETH, the balance minus `reserved`; for any other token, its whole balance.
    function spare(address asset) public view returns (uint256) {
        uint256 bal = asset == address(0) ? address(this).balance : IERC20Min(asset).balanceOf(address(this));
        uint256 r;
        if (asset == token) r += reservedPool();
        if (asset == address(0)) r += challengeEscrow + owedEthTotal;
        return bal > r ? bal - r : 0;
    }

    /// @notice The event's asset that must stay here: deposits, shares not yet withdrawn, refunds owed.
    function reservedPool() public view returns (uint256 r) {
        if (phase == Phase.Finalized) r = payoutShare * (attendeeCount + openCases) - sharePaidTotal;
        else r = depositAmount * stakerCount;
        r += owedTotal;
    }

    /// @notice The organiser returns spare money (tokens or ETH sent here by mistake, rounding dust after payout).
    function recoverSpare(address asset, address to, uint256 amount) external nonReentrant onlyOwner {
        require(to != address(0) && to != address(this), ZeroAddress());
        uint256 s = spare(asset);
        require(amount <= s, SpareTooLow(s));
        emit SpareRecovered(asset, to, amount);
        if (asset == address(0)) {
            _sendEth(to, amount);
        } else {
            // a token reachable at a second address must not take the event's own token with it
            address t = token;
            uint256 before = t == address(0) || t == asset ? 0 : IERC20Min(t).balanceOf(address(this));
            _callToken(asset, abi.encodeCall(IERC20Min.transfer, (to, amount)), gasleft(), true);
            if (t != address(0) && t != asset) require(IERC20Min(t).balanceOf(address(this)) >= before, SpareTooLow(0));
        }
    }

    // ------------------------------------------------------------------ admin

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), ZeroAddress());
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        require(msg.sender == pendingOwner, NotPendingOwner());
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    // ------------------------------------------------------------------ views

    /// @notice Every wallet that ever deposited (check `status`).
    function stakers() external view returns (address[] memory) {
        return _stakers;
    }

    function attendees() external view returns (address[] memory) {
        return _attendees;
    }

    function challengers() external view returns (address[] memory) {
        return _challengers;
    }

    /// @notice Kleros extra data (abi.encode(subcourtID, minJurors)) and the juror policy, for every event.
    function arbitrationSettings() external view returns (bytes memory extraData, string memory policyURI) {
        return _settings();
    }

    /// @notice ETH needed to open (or match) a challenge right now: the Kleros arbitration cost.
    function challengeDeposit() public view returns (uint256) {
        (bytes memory extraData,) = _settings();
        return arbitrator.arbitrationCost(extraData);
    }

    /// @notice The case description (ERC-1497 metaevidence) of a challenge by `staker`, and its IPFS path
    /// ("/ipfs/Qm...", CIDv0 as `ipfs add` computes it with default settings). It names the event, the wallet, the
    /// organiser (the owner when the challenge was opened, or now if not challenged yet) and this contract. Anyone
    /// can publish `text` to IPFS (e.g. Kleros's upload service) so jurors can read it.
    function caseMetaEvidence(address staker) public view returns (string memory text, string memory uri) {
        address org = challenges[staker].organiser;
        if (org == address(0)) org = owner;
        return caseWriter.write(
            PresenceCaseWriter.Facts({
                staker: staker,
                eventContract: address(this),
                organiser: org,
                name: eventName,
                url: eventURL,
                start: eventStart,
                end: eventEnd,
                depositAmount: depositAmount,
                decimals: tokenDecimals,
                symbol: tokenSymbol,
                token: token
            })
        );
    }

    /// @notice Where the Kleros case on `staker`'s challenge stands, for an appeal (fund it on the Dispute Resolver:
    /// `fundAppeal(challenges(staker).localDisputeID, side)`).
    function appealStatus(address staker)
        external
        view
        returns (uint256 ruling, uint256 start, uint256 end, uint256 loserEnd, uint256 costAttended, uint256 costAbsent)
    {
        Challenge storage c = challenges[staker];
        require(c.state == ChallengeState.Disputed, NotAppealable(staker));
        uint256 id = c.arbitratorDisputeID;
        ruling = arbitrator.currentRuling(id);
        (start, end) = arbitrator.appealPeriod(id);
        if (end == 0) return (ruling, 0, 0, 0, 0, 0);
        uint256 winner;
        uint256 loser;
        (loserEnd, winner, loser) = _appealCosts(id, start, end);
        costAttended = ruling == RULING_ATTENDED ? winner : loser;
        costAbsent = ruling == RULING_ABSENT ? winner : loser;
    }

    function _appealCosts(uint256 id, uint256 start, uint256 end) private view returns (uint256 loserEnd, uint256 winner, uint256 loser) {
        (uint256 winnerMul, uint256 loserMul, uint256 loserPeriodMul, uint256 denominator) = disputeResolver.getMultipliers();
        loserEnd = start + ((end - start) * loserPeriodMul) / denominator;
        (bytes memory extraData,) = _settings();
        uint256 cost = arbitrator.appealCost(id, extraData);
        winner = _withStake(cost, winnerMul, denominator);
        loser = _withStake(cost, loserMul, denominator);
    }

    /// @notice Everything a page needs in one call.
    function summary()
        external
        view
        returns (
            Phase phase_,
            uint256 stakerCount_,
            uint256 attendeeCount_,
            uint256 challengeEndsAt_,
            uint256 waitingChallenges_,
            uint256 openCases_,
            uint256 payoutShare_,
            uint256 reservedPool_,
            uint256 challengeEscrow_
        )
    {
        return (phase, stakerCount, attendeeCount, challengeEndsAt, waitingChallenges, openCases, payoutShare, reservedPool(), challengeEscrow);
    }

    // ------------------------------------------------------------------ internal: money

    /// @dev The pool money `account` can take now (a share after payout, the deposit after a cancellation or a
    /// missed deadline).
    function _poolPart(address account) private view returns (uint256) {
        if (phase == Phase.Finalized) return attended[account] ? payoutShare - sharePaid[account] : 0;
        if (status[account] != Status.Staker) return 0;
        if (phase == Phase.Cancelled || (phase == Phase.Open && block.timestamp > claimDeadline)) return depositAmount;
        return 0;
    }

    /// @dev Marks the pool part as taken and returns it.
    function _takePool(address account) private returns (uint256 amount) {
        amount = _poolPart(account);
        if (amount == 0) return 0;
        if (phase == Phase.Finalized) {
            sharePaid[account] += amount;
            sharePaidTotal += amount;
        } else {
            status[account] = Status.Refunded;
            stakerCount -= 1;
        }
    }

    /// @dev Push a payment with a gas allowance; if it fails it is kept claimable (`owed` / `owedEth`).
    function _push(address to, uint256 amount, bool eth) private {
        if (amount == 0) return;
        bool isEth = eth || token == address(0);
        bool ok;
        if (isEth) {
            assembly ("memory-safe") {
                ok := call(PUSH_GAS_ETH, to, amount, 0, 0, 0, 0)
            }
        } else {
            ok = _callToken(token, abi.encodeCall(IERC20Min.transfer, (to, amount)), PUSH_GAS_TOKEN, false);
        }
        if (ok) {
            emit Paid(to, to, amount, isEth);
            return;
        }
        // only a recipient that had its full allowance counts as failed: a caller who sends too little gas reverts
        require(gasleft() >= (isEth ? PUSH_GAS_ETH : PUSH_GAS_TOKEN) / 63, NotEnoughGas());
        if (eth) {
            owedEth[to] += amount;
            owedEthTotal += amount;
        } else {
            owed[to] += amount;
            owedTotal += amount;
        }
        emit PaymentFailed(to, amount, isEth);
    }

    function _sendEth(address to, uint256 amount) private {
        bool ok;
        assembly ("memory-safe") {
            ok := call(gas(), to, amount, 0, 0, 0, 0)
        }
        require(ok, TransferFailed(to, amount));
    }

    /// @dev An ERC-20 call that accepts tokens returning true or nothing (USDT). `strict` reverts on failure.
    function _callToken(address t, bytes memory data, uint256 gasLimit, bool strict) private returns (bool ok) {
        bool success;
        uint256 size;
        uint256 word;
        assembly ("memory-safe") {
            success := call(gasLimit, t, 0, add(data, 32), mload(data), 0, 32)
            size := returndatasize()
            word := mload(0)
        }
        ok = success && (size == 0 || (size >= 32 && word == 1));
        if (strict) require(ok, TransferFailed(t, 0));
    }

    function _addAttendee(address a) private {
        require(status[a] == Status.Staker, NotAStaker(a));
        require(!attended[a], DuplicateAttendee(a));
        attended[a] = true;
        _attendees.push(a);
        attendeeCount += 1;
        emit AttendeeAdded(a);
    }

    function _acceptUnmatched(address staker, Challenge storage c) private {
        c.state = ChallengeState.Resolved;
        waitingChallenges -= 1;
        challengeEscrow -= c.deposit;
        _addAttendee(staker);
        emit ChallengeResolved(staker, true, RULING_ATTENDED);
        _push(staker, c.deposit, true);
    }

    // ------------------------------------------------------------------ internal: text

    function _settings() private view returns (bytes memory extraData, string memory policyURI) {
        return abi.decode(_readStore(_settingsStore), (bytes, string));
    }


    /// @dev Text that can sit inside a JSON string as it is: no quote, backslash or control character.
    function _jsonSafe(bytes memory s) private pure returns (bool) {
        for (uint256 i; i < s.length; ++i) {
            uint8 ch = uint8(s[i]);
            if (ch < 0x20 || ch == 0x22 || ch == 0x5c || ch == 0x7f) return false;
        }
        return true;
    }

    /// @dev symbol() and decimals(), kept only if plain (letters, digits, ". _ -", up to 16 bytes).
    function _tokenInfo(address t) private view returns (string memory sym, uint8 dec) {
        sym = "tokens";
        dec = 18;
        (bool ok, bytes memory ret) = t.staticcall(abi.encodeWithSignature("decimals()"));
        if (ok && ret.length >= 32) {
            uint256 d = abi.decode(ret, (uint256));
            if (d <= 36) dec = uint8(d);
        }
        (ok, ret) = t.staticcall(abi.encodeWithSignature("symbol()"));
        if (!ok || ret.length < 64) return (sym, dec);
        (uint256 offset, uint256 len) = (0, 0);
        assembly ("memory-safe") {
            offset := mload(add(ret, 32))
            len := mload(add(ret, 64))
        }
        if (offset != 32 || len == 0 || len > 16 || ret.length < 64 + len) return (sym, dec);
        bytes memory s = new bytes(len);
        for (uint256 i; i < len; ++i) {
            bytes1 ch = ret[64 + i];
            bool plain = (ch >= "0" && ch <= "9") || (ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z") || ch == "." || ch == "_" || ch == "-";
            if (!plain) return (sym, dec);
            s[i] = ch;
        }
        sym = string(s);
    }







    /// @dev Keeps `data` as the code of a new contract, after a STOP byte so it can never run.
    function _storeData(bytes memory data) private returns (address store) {
        require(data.length < 24_576, BadTemplate());
        bytes memory init = bytes.concat(hex"61", bytes2(uint16(data.length + 1)), hex"80600a3d393df300", data);
        assembly ("memory-safe") {
            store := create(0, add(init, 32), mload(init))
        }
        require(store != address(0), BadTemplate());
    }

    function _readStore(address store) private view returns (bytes memory data) {
        uint256 size = store.code.length - 1;
        data = new bytes(size);
        assembly ("memory-safe") {
            extcodecopy(store, add(data, 32), 1, size)
        }
    }



    function _withStake(uint256 cost, uint256 multiplier, uint256 denominator) private pure returns (uint256) {
        unchecked {
            uint256 product = cost * multiplier;
            if (cost != 0 && product / cost != multiplier) product = type(uint256).max;
            uint256 total = cost + product / denominator;
            return total < cost ? type(uint256).max : total;
        }
    }
}
