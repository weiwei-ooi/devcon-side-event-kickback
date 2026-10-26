// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Minimal ERC-20 interface (USDC-compatible).
interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
}

/// @notice Kleros v2 arbitrator (KlerosCore): the fee and the appeal views we need.
interface IArbitratorV2 {
    function arbitrationCost(bytes calldata extraData) external view returns (uint256 cost);
    function appealCost(uint256 disputeID) external view returns (uint256 cost);
    function appealPeriod(uint256 disputeID) external view returns (uint256 start, uint256 end);
    function currentRuling(uint256 disputeID) external view returns (uint256 ruling, bool tied, bool overridden);
    function getNumberOfRounds(uint256 disputeID) external view returns (uint256);
    function disputeKits(uint256 disputeKitID) external view returns (address);
}

/// @notice Kleros v2 DisputeKitClassic: appeals are crowdfunded here (KlerosCore only accepts an
/// appeal from the dispute kit). The side that lost the round pays the appeal cost plus
/// LOSER_STAKE_MULTIPLIER and only during the first part of the appeal period; the side that won
/// pays the cost plus WINNER_STAKE_MULTIPLIER. Once both sides are fully funded, a new round starts.
interface IDisputeKitClassic {
    function fundAppeal(uint256 coreDisputeID, uint256 choice) external payable;
    function WINNER_STAKE_MULTIPLIER() external view returns (uint256);
    function LOSER_STAKE_MULTIPLIER() external view returns (uint256);
    function LOSER_APPEAL_PERIOD_MULTIPLIER() external view returns (uint256);
}

/// @notice Kleros v2 DisputeResolver: a general-purpose arbitrable that anyone can use to open a
/// Kleros dispute from a dispute template. Kleros Court only accepts disputes from whitelisted
/// contracts; the DisputeResolver is one of them, so going through it keeps this contract
/// permissionless. The ruling is read back from it with `disputes(localID)`.
interface IDisputeResolver {
    function arbitrator() external view returns (IArbitratorV2);
    function createDisputeForTemplate(
        bytes calldata arbitratorExtraData,
        string calldata disputeTemplate,
        string calldata disputeTemplateDataMappings,
        uint256 numberOfRulingOptions
    ) external payable returns (uint256 arbitratorDisputeID);
    function arbitratorDisputeIDToLocalID(uint256 arbitratorDisputeID) external view returns (uint256);
    function disputes(uint256 localID)
        external
        view
        returns (bytes memory arbitratorExtraData, bool isRuled, uint256 ruling, uint256 numberOfRulingOptions);
}

/// @title GroundTruthKickback (v4)
/// @notice Kickback-style refundable deposits for an IRL event, with Kleros-arbitrated attendance.
///
/// Flow
///  1. Guests send exactly `deposit` of `token` to this contract (plain ERC-20 transfer)
///     and paste the tx link into their Luma registration.
///  2. Off-chain, the organiser verifies each tx (scripts/verify-deposits.mjs) and curates on
///     Luma. Approved guests are added with `registerStakers`. Declined guests (bots, wrong
///     audience) get their deposit straight back with `rejectAndRefund`, in one transaction
///     for the whole batch. A registered staker who drops out can be rejected the same way.
///  3. After the event starts, the organiser publishes who checked in with `postAttendance`.
///  4. Challenge window (1 day): a registered staker left off the list who says they attended
///     calls `challenge`, paying a challenge deposit equal to the Kleros arbitration cost (ETH).
///  5. Match window (1 day from each challenge): anyone (usually the organiser) who disagrees
///     calls `matchChallenge` with the same deposit, which opens a Kleros dispute. If nobody
///     matches, the challenger counts as having attended and gets their deposit back.
///  5b. Appeals: after each Kleros vote, either side can appeal. Anyone can chip in with
///     `fundAppeal(staker, side)`; the money goes to Kleros's dispute kit and this contract keeps
///     track of who paid what. Once the case has its final ruling and is settled, each funder
///     takes their part of what Kleros returns (refunds and rewards) with `claimAppealRewards`.
///     Only the final ruling counts: the DisputeResolver records it after the last appeal period.
///  6. Once the challenge window is over and no challenge is still waiting for a match, anyone
///     can call `releasePayouts`. The staked pool (deposit x stakers) is split into equal shares,
///     one per attendee plus one per challenger still in a Kleros case: attendees are paid at
///     once and one share is set aside per open case, so a dispute (or an appeal) cannot hold
///     everyone's money. When the case is settled, the set-aside share goes to the challenger if
///     Kleros rules they attended, otherwise it is split among the attendees.
///     A transfer that fails (e.g. a USDC-blocklisted wallet) does not block the
///     others: that share is kept for the attendee to `claim` later, to any address they choose.
///  7. Anything not owed to anyone (rounding dust, stray or excess transfers) can be refunded
///     or swept by the owner, but never the staked pool or unclaimed payouts.
///
/// Safety nets
///  - `cancel` refunds every registered staker if the event is called off (before the list is posted).
///  - If the organiser never posts the list (lost key), every registered staker can take their
///    own deposit back with `emergencyWithdraw` once `claimDeadline` has passed. Posting is only
///    possible up to `claimDeadline`, so the two can never race. Once the list is posted the
///    payout is permissionless, so the organiser cannot hold it back.
///  - Ownership changes need the new owner to accept, so a typo cannot lock the contract.
contract GroundTruthKickback {
    // ------------------------------------------------------------------ errors
    error NotOwner();
    error NotPendingOwner();
    error NotOpen();
    error NotListed();
    error NotSettled();
    error ZeroAddress();
    error BadTimes();
    error TooLate();
    error TooEarly();
    error Reentrancy();
    error AlreadyRegistered(address staker);
    error NotAStaker(address account);
    error CannotReject(address account);
    error DuplicateAttendee(address account);
    error NoAttendees();
    error ShareMismatch(uint256 expected, uint256 actual);
    error InsufficientBalance(uint256 required, uint256 available);
    error NothingToClaim();
    error TransferFailed(address to, uint256 amount);
    error AlreadyAttending(address account);
    error AlreadyChallenged(address account);
    error NoChallenge(address account);
    error WrongChallengeState(address account);
    error WrongDeposit(uint256 required, uint256 sent);
    error ArbitrationCostTooHigh(uint256 cost, uint256 available);
    error NotRuled(address account);
    error ChallengesPending(uint256 count);
    error OnlyNumberedRulings();
    error InDispute(address staker);
    error BadSide(uint256 side);
    error NotAppealable(address staker);
    error AppealWithdrawFailed();

    // ------------------------------------------------------------------ events
    event StakerRegistered(address indexed staker);
    event Rejected(address indexed wallet, uint256 refunded);
    event AttendancePosted(uint256 attendees, uint256 challengeEndsAt);
    event AttendeeAdded(address indexed attendee);
    event Challenged(address indexed staker, uint256 deposit, uint256 matchEndsAt);
    event ChallengeMatched(address indexed staker, address indexed matcher, uint256 arbitratorDisputeID);
    event ChallengeResolved(address indexed staker, bool attended, uint256 ruling);
    event Payout(address indexed attendee, uint256 amount);
    event PayoutFailed(address indexed attendee, uint256 amount);
    event Claimed(address indexed attendee, address indexed to, uint256 amount);
    event Finalized(uint256 stakers, uint256 attendees, uint256 pool, uint256 share);
    event ShareHeldBack(address indexed staker, uint256 amount);
    event HeldShareSplit(address indexed staker, uint256 attendees, uint256 each);
    event Cancelled(uint256 stakers, uint256 refundedEach);
    event EmergencyWithdrawn(address indexed staker, uint256 amount);
    event Refunded(address indexed to, uint256 amount);
    event Swept(address indexed to, uint256 amount);
    event EthOwed(address indexed to, uint256 amount);
    event AppealFunded(address indexed staker, address indexed funder, uint256 round, uint256 side, uint256 amount);
    event AppealFundsCollected(address indexed staker, uint256 amount);
    event AppealRewardClaimed(address indexed staker, address indexed funder, address to, uint256 amount);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    // ------------------------------------------------------------------ state
    enum Phase {
        Open, // deposits and curation
        Listed, // attendance posted: challenge window, then waiting for disputes
        Finalized, // pool paid out
        Cancelled // event called off, deposits refunded
    }

    enum Status {
        None,
        Staker,
        Paid,
        Rejected
    }

    enum ChallengeState {
        None,
        Waiting, // challenger paid, waiting for someone to match
        Disputed, // matched: a Kleros dispute is open
        Resolved
    }

    struct Challenge {
        ChallengeState state;
        address matcher;
        uint64 matchEndsAt;
        uint256 deposit; // ETH paid by each side
        uint256 arbitratorDisputeID;
        uint256 localDisputeID; // id inside the DisputeResolver
        uint256 arbitrationPaid; // ETH spent on the Kleros fee
        bool shareHeld; // still in a Kleros case at payout: one share is set aside for it
    }

    /// @notice Kleros settings, passed to the constructor as one struct.
    struct Arbitration {
        IDisputeResolver disputeResolver;
        bytes extraData; // abi.encode(courtID, minJurors, disputeKitID)
        string policyURI; // IPFS path of the attendance policy jurors apply, e.g. /ipfs/Qm...
    }

    /// @notice Ruling options for a Kleros attendance dispute (0 = refused to arbitrate).
    uint256 public constant RULING_ATTENDED = 1;
    uint256 public constant RULING_ABSENT = 2;
    uint256 public constant CHALLENGE_PERIOD = 1 days;
    uint256 public constant MATCH_PERIOD = 1 days;
    /// @notice Minimum time between the event start and the deadline, so a late list is still possible.
    uint256 public constant MIN_SETTLEMENT_WINDOW = 7 days;

    IERC20 public immutable token;
    uint256 public immutable deposit;
    /// @notice `postAttendance` is only possible from this time (unix seconds): no accidental early payout.
    uint256 public immutable eventStart;
    /// @notice Deadline to post the attendance list. After it, if still open, stakers can withdraw their own deposit.
    uint256 public immutable claimDeadline;
    IDisputeResolver public immutable disputeResolver;
    bytes public arbitratorExtraData;
    string public policyURI;
    string public eventName;

    address public owner;
    address public pendingOwner;
    Phase public phase;

    mapping(address => Status) public status;
    address[] private _stakers;
    uint256 public stakerCount; // active stakers

    mapping(address => bool) public attended;
    address[] private _attendees;
    uint256 public attendeeCount;
    uint256 public challengeEndsAt;

    mapping(address => Challenge) public challenges;
    address[] private _challengers;
    uint256 public pendingChallenges; // waiting for a match, or in a Kleros dispute
    /// @notice The per-attendee payout, set by `releasePayouts`.
    uint256 public payoutShare;
    /// @notice USDC set aside at payout for challengers still in a Kleros case (one share each).
    uint256 public heldBack;

    /// @notice USDC payouts that could not be delivered and are waiting for `claim`.
    mapping(address => uint256) public owed;
    uint256 public owedTotal;
    /// @notice ETH (challenge deposits) that could not be sent and is waiting for `withdrawEth`.
    mapping(address => uint256) public ethOwed;

    /// @notice Appeal money paid to Kleros through this contract, per challenged staker, round and side.
    mapping(address staker => mapping(uint256 round => mapping(uint256 side => uint256))) public appealPaid;
    /// @notice Each funder's part of `appealPaid`.
    mapping(address staker => mapping(uint256 round => mapping(uint256 side => mapping(address funder => uint256))))
        public appealContribution;
    /// @notice What Kleros paid back (refunds + rewards) for that round and side, once collected.
    mapping(address staker => mapping(uint256 round => mapping(uint256 side => uint256))) public appealReturned;
    /// @notice Number of rounds (from the first) that may hold appeal money paid through this contract.
    mapping(address staker => uint256) public appealRounds;
    mapping(address staker => bool) public appealFundsCollected;
    /// @notice The dispute kit used for disputes (from the arbitrator extra data: courtID, minJurors, disputeKitID).
    uint256 public immutable disputeKitID;

    uint256 private _locked = 1;

    // ------------------------------------------------------------------ setup
    constructor(
        IERC20 token_,
        uint256 deposit_,
        string memory eventName_,
        address owner_,
        uint256 eventStart_,
        uint256 claimDeadline_,
        Arbitration memory arbitration_
    ) {
        require(address(token_) != address(0), ZeroAddress());
        require(owner_ != address(0), ZeroAddress());
        require(address(arbitration_.disputeResolver) != address(0), ZeroAddress());
        require(claimDeadline_ >= eventStart_ + MIN_SETTLEMENT_WINDOW, BadTimes());
        token = token_;
        deposit = deposit_;
        eventName = eventName_;
        owner = owner_;
        eventStart = eventStart_;
        claimDeadline = claimDeadline_;
        disputeResolver = arbitration_.disputeResolver;
        arbitratorExtraData = arbitration_.extraData;
        uint256 kitID = 1; // Kleros's classic dispute kit when the extra data does not say
        if (arbitration_.extraData.length >= 96) (,, kitID) = abi.decode(arbitration_.extraData, (uint256, uint256, uint256));
        disputeKitID = kitID;
        policyURI = arbitration_.policyURI;
        emit OwnershipTransferred(address(0), owner_);
    }

    modifier onlyOwner() {
        require(msg.sender == owner, NotOwner());
        _;
    }

    modifier whenOpen() {
        require(phase == Phase.Open, NotOpen());
        _;
    }

    modifier whenListed() {
        require(phase == Phase.Listed, NotListed());
        _;
    }

    /// @dev Posting the list and cancelling are only possible up to the deadline; after it, stakers exit themselves.
    modifier beforeDeadline() {
        require(block.timestamp <= claimDeadline, TooLate());
        _;
    }

    modifier nonReentrant() {
        require(_locked == 1, Reentrancy());
        _locked = 2;
        _;
        _locked = 1;
    }

    // ------------------------------------------------------------------ views

    /// @notice USDC that must stay in the contract: the staked pool until paid out (then the shares
    /// set aside for open Kleros cases), plus unclaimed payouts.
    function reserved() public view returns (uint256) {
        bool poolHeld = phase == Phase.Open || phase == Phase.Listed;
        return (poolHeld ? deposit * stakerCount : heldBack) + owedTotal;
    }

    /// @notice USDC in the contract that nobody is owed (stray/excess/declined-not-yet-refunded).
    function spare() public view returns (uint256) {
        uint256 bal = token.balanceOf(address(this));
        uint256 r = reserved();
        return bal > r ? bal - r : 0;
    }

    /// @notice All wallets ever registered (check `status` to see if still active / paid / rejected).
    /// A wallet that was refunded and registered again appears twice.
    function stakers() external view returns (address[] memory) {
        return _stakers;
    }

    /// @notice Everyone on the attendance list so far (posted, added, or confirmed by a challenge).
    function attendees() external view returns (address[] memory) {
        return _attendees;
    }

    /// @notice Every staker who opened a challenge.
    function challengers() external view returns (address[] memory) {
        return _challengers;
    }

    /// @notice Preview the payout per attendee for a given attendee count.
    function previewShare(uint256 attendeeCount_) external view returns (uint256) {
        if (attendeeCount_ == 0) return 0;
        return (deposit * stakerCount) / attendeeCount_;
    }

    /// @notice ETH needed to open a challenge right now: the Kleros arbitration cost. Matching an
    /// open challenge takes that challenge's own deposit (`challenges(staker).deposit`).
    function challengeDeposit() public view returns (uint256) {
        return disputeResolver.arbitrator().arbitrationCost(arbitratorExtraData);
    }

    /// @notice Where the Kleros case on `staker`'s challenge stands, for an appeal.
    /// @return round Current round (1 = first jury).
    /// @return ruling The jury's current vote (0 none/tied, 1 attended, 2 absent).
    /// @return start Start of the appeal period (0 if the case is not in its appeal period).
    /// @return end End of the appeal period.
    /// @return loserEnd Until when the side that lost the vote can still be funded.
    /// @return costAttended Total needed to fund the "attended" side this round.
    /// @return costAbsent Total needed to fund the "absent" side this round.
    function appealStatus(address staker)
        external
        view
        returns (uint256 round, uint256 ruling, uint256 start, uint256 end, uint256 loserEnd, uint256 costAttended, uint256 costAbsent)
    {
        Challenge storage c = challenges[staker];
        require(c.state == ChallengeState.Disputed, NotAppealable(staker));
        IArbitratorV2 core = disputeResolver.arbitrator();
        uint256 id = c.arbitratorDisputeID;
        round = core.getNumberOfRounds(id);
        (ruling,,) = core.currentRuling(id);
        (start, end) = core.appealPeriod(id);
        if (end == 0) return (round, ruling, 0, 0, 0, 0, 0);
        IDisputeKitClassic kit = _disputeKit(core);
        loserEnd = start + ((end - start) * kit.LOSER_APPEAL_PERIOD_MULTIPLIER()) / 10_000;
        uint256 cost = core.appealCost(id);
        uint256 winner = cost + (cost * kit.WINNER_STAKE_MULTIPLIER()) / 10_000;
        uint256 loser = cost + (cost * kit.LOSER_STAKE_MULTIPLIER()) / 10_000;
        costAttended = ruling == RULING_ATTENDED ? winner : loser;
        costAbsent = ruling == RULING_ABSENT ? winner : loser;
    }

    /// @notice ETH `funder` can claim with `claimAppealRewards` once the case is settled (0 before Kleros paid back).
    function appealRewardOf(address staker, address funder) public view returns (uint256 amount) {
        uint256 rounds = appealRounds[staker];
        for (uint256 r; r < rounds; ++r) {
            for (uint256 side = RULING_ATTENDED; side <= RULING_ABSENT; ++side) {
                uint256 mine = appealContribution[staker][r][side][funder];
                if (mine > 0) amount += (mine * appealReturned[staker][r][side]) / appealPaid[staker][r][side];
            }
        }
    }

    // ------------------------------------------------------------------ curation (organiser)

    /// @notice Record wallets whose deposit was verified off-chain and that the organiser approved.
    function registerStakers(address[] calldata wallets) external onlyOwner whenOpen {
        for (uint256 i; i < wallets.length; ++i) {
            address s = wallets[i];
            require(s != address(0), ZeroAddress());
            Status st = status[s];
            // a rejected (refunded) wallet may come back if the organiser approves it after a new deposit
            require(st == Status.None || st == Status.Rejected, AlreadyRegistered(s));
            status[s] = Status.Staker;
            _stakers.push(s);
            emit StakerRegistered(s);
        }
        stakerCount += wallets.length;
        uint256 bal = token.balanceOf(address(this));
        require(bal >= reserved(), InsufficientBalance(reserved(), bal));
    }

    /// @notice Decline guests and send each one exactly `deposit` back, to their own wallet.
    /// Works for verified-but-declined payers (never registered) and, while open, for registered
    /// stakers who drop out. Unregistered payers can also be refunded later (late payers). The
    /// refund always goes to the rejected wallet itself; if that transfer fails (e.g. a
    /// blocklisted wallet) the amount is kept for them to `claim` to another address, so one bad
    /// wallet never blocks the batch.
    function rejectAndRefund(address[] calldata wallets) external onlyOwner {
        for (uint256 i; i < wallets.length; ++i) {
            address w = wallets[i];
            require(w != address(0), ZeroAddress());
            Status st = status[w];
            if (st == Status.Staker && phase == Phase.Open) {
                stakerCount -= 1; // their deposit leaves the pool and goes back to them
            } else {
                require(st == Status.None, CannotReject(w));
                // an unregistered payer can only be refunded from money nobody else is owed
                require(spare() >= deposit, InsufficientBalance(reserved() + deposit, token.balanceOf(address(this))));
            }
            status[w] = Status.Rejected;
            emit Rejected(w, deposit);
            _payOrOwe(w, deposit);
        }
    }

    /// @notice Return an overpayment or a stray transfer. Only spare money can be refunded:
    /// never the staked pool or unclaimed payouts. Allowed before and after settlement.
    function refund(address to, uint256 amount) external onlyOwner {
        require(amount <= spare(), InsufficientBalance(reserved() + amount, token.balanceOf(address(this))));
        _sendOrRevert(to, amount);
        emit Refunded(to, amount);
    }

    // ------------------------------------------------------------------ attendance

    /// @notice Publish the registered stakers who checked in. Opens the 1-day challenge window.
    /// @param list Registered stakers who checked in at the venue (no duplicates).
    /// @param expectedShare The per-attendee amount the organiser saw and confirmed in the console.
    function postAttendance(address[] calldata list, uint256 expectedShare) external onlyOwner whenOpen beforeDeadline {
        require(block.timestamp >= eventStart, TooEarly());
        require(list.length > 0, NoAttendees());
        uint256 pool = deposit * stakerCount;
        uint256 bal = token.balanceOf(address(this));
        require(bal >= pool + owedTotal, InsufficientBalance(pool + owedTotal, bal));
        uint256 share = pool / list.length;
        require(share == expectedShare, ShareMismatch(expectedShare, share));

        for (uint256 i; i < list.length; ++i) {
            _addAttendee(list[i]);
        }
        phase = Phase.Listed;
        challengeEndsAt = block.timestamp + CHALLENGE_PERIOD;
        emit AttendancePosted(list.length, challengeEndsAt);
    }

    /// @notice The organiser adds stakers they left off the list by mistake (during the challenge window).
    /// If such a staker already challenged and nobody matched yet, their challenge deposit goes back to them.
    function addAttendees(address[] calldata list) external onlyOwner whenListed nonReentrant {
        require(block.timestamp <= challengeEndsAt, TooLate());
        for (uint256 i; i < list.length; ++i) {
            address a = list[i];
            Challenge storage c = challenges[a];
            // once in a Kleros case the jurors decide; the organiser can say so in the case (policy: rule Yes)
            require(c.state != ChallengeState.Disputed, InDispute(a));
            _addAttendee(a);
            if (c.state == ChallengeState.Waiting) {
                c.state = ChallengeState.Resolved;
                pendingChallenges -= 1;
                emit ChallengeResolved(a, true, RULING_ATTENDED);
                _sendEth(a, c.deposit);
            }
        }
    }

    // ------------------------------------------------------------------ challenges (Kleros)

    /// @notice A registered staker left off the list says they attended. Pay `challengeDeposit()` in ETH.
    function challenge() external payable whenListed nonReentrant {
        require(block.timestamp <= challengeEndsAt, TooLate());
        require(status[msg.sender] == Status.Staker, NotAStaker(msg.sender));
        require(!attended[msg.sender], AlreadyAttending(msg.sender));
        Challenge storage c = challenges[msg.sender];
        require(c.state == ChallengeState.None, AlreadyChallenged(msg.sender));
        uint256 cost = challengeDeposit();
        require(msg.value >= cost, WrongDeposit(cost, msg.value));

        c.state = ChallengeState.Waiting;
        c.deposit = cost;
        c.matchEndsAt = uint64(block.timestamp + MATCH_PERIOD);
        _challengers.push(msg.sender);
        pendingChallenges += 1;
        emit Challenged(msg.sender, cost, c.matchEndsAt);
        if (msg.value > cost) _sendEth(msg.sender, msg.value - cost);
    }

    /// @notice Disagree with a challenge: match its deposit within 1 day. This opens a Kleros dispute.
    function matchChallenge(address staker) external payable whenListed nonReentrant {
        Challenge storage c = challenges[staker];
        require(c.state != ChallengeState.None, NoChallenge(staker));
        require(c.state == ChallengeState.Waiting, WrongChallengeState(staker));
        require(block.timestamp <= c.matchEndsAt, TooLate());
        require(msg.value >= c.deposit, WrongDeposit(c.deposit, msg.value));

        // the fee is paid from the two deposits; the rest goes to whoever wins
        uint256 cost = challengeDeposit();
        require(cost <= 2 * c.deposit, ArbitrationCostTooHigh(cost, 2 * c.deposit));
        c.state = ChallengeState.Disputed;
        c.matcher = msg.sender;
        c.arbitrationPaid = cost;
        uint256 id = disputeResolver.createDisputeForTemplate{value: cost}(
            arbitratorExtraData, _disputeTemplate(staker), "", RULING_ABSENT
        );
        c.arbitratorDisputeID = id;
        c.localDisputeID = disputeResolver.arbitratorDisputeIDToLocalID(id);
        emit ChallengeMatched(staker, msg.sender, id);
        if (msg.value > c.deposit) _sendEth(msg.sender, msg.value - c.deposit);
    }

    /// @notice Settle a challenge once it can be: unmatched after its match window (counts as
    /// attended), or ruled by Kleros. Anyone can call it.
    function resolveChallenge(address staker) external nonReentrant {
        Challenge storage c = challenges[staker];
        require(c.state != ChallengeState.None, NoChallenge(staker));
        if (c.state == ChallengeState.Waiting) {
            require(block.timestamp > c.matchEndsAt, TooEarly());
            _acceptUnmatched(staker, c);
        } else {
            require(c.state == ChallengeState.Disputed, WrongChallengeState(staker));
            (, bool isRuled, uint256 ruling,) = disputeResolver.disputes(c.localDisputeID);
            require(isRuled, NotRuled(staker));
            require(ruling <= RULING_ABSENT, OnlyNumberedRulings());
            c.state = ChallengeState.Resolved;
            pendingChallenges -= 1;

            bool won = ruling == RULING_ATTENDED;
            if (won && !attended[staker] && phase == Phase.Listed) _addAttendee(staker);
            emit ChallengeResolved(staker, won, ruling);
            if (c.shareHeld) _settleHeldShare(staker, won);

            uint256 remaining = 2 * c.deposit - c.arbitrationPaid;
            if (won) {
                _sendEth(staker, remaining);
            } else if (ruling == RULING_ABSENT) {
                _sendEth(c.matcher, remaining);
            } else {
                // refused to arbitrate: both sides get half back
                _sendEth(staker, remaining / 2);
                _sendEth(c.matcher, remaining - remaining / 2);
            }
        }
    }

    // ------------------------------------------------------------------ appeals (Kleros)

    /// @notice Appeal the Kleros vote on `staker`'s challenge, or defend it: fund one side
    /// (1 = attended, 2 = did not attend) with any amount. The ETH goes to Kleros's dispute kit,
    /// which keeps what is still missing for that side and returns the rest (sent back to you).
    /// Kleros's own rules apply: see `appealStatus` for the deadlines and amounts.
    function fundAppeal(address staker, uint256 side) external payable nonReentrant {
        Challenge storage c = challenges[staker];
        require(c.state == ChallengeState.Disputed, NotAppealable(staker));
        require(side == RULING_ATTENDED || side == RULING_ABSENT, BadSide(side));
        require(msg.value > 0, WrongDeposit(1, 0));
        IArbitratorV2 core = disputeResolver.arbitrator();
        uint256 id = c.arbitratorDisputeID;
        uint256 round = core.getNumberOfRounds(id) - 1;

        // the kit refunds any surplus to this contract; what it kept is the contribution
        uint256 before = address(this).balance;
        _disputeKit(core).fundAppeal{value: msg.value}(id, side);
        uint256 spent = before - address(this).balance;

        appealPaid[staker][round][side] += spent;
        appealContribution[staker][round][side][msg.sender] += spent;
        if (appealRounds[staker] <= round) appealRounds[staker] = round + 1;
        emit AppealFunded(staker, msg.sender, round, side, spent);
        _sendEth(msg.sender, msg.value - spent);
    }

    /// @notice After the final ruling and `resolveChallenge`, collect from Kleros the appeal money
    /// paid through this contract (refunds for sides never fully funded, rewards for the winning side).
    /// Anyone can call it; `claimAppealRewards` also does it when needed.
    function collectAppealFunds(address staker) external nonReentrant {
        _collectAppealFunds(staker);
    }

    /// @notice Take your part of what Kleros returned for the appeals you funded on `staker`'s case.
    function claimAppealRewards(address staker, address payable to) external nonReentrant {
        require(to != address(0) && to != address(this), ZeroAddress());
        if (!appealFundsCollected[staker]) _collectAppealFunds(staker);
        uint256 amount = appealRewardOf(staker, msg.sender);
        uint256 rounds = appealRounds[staker];
        bool funded;
        for (uint256 r; r < rounds; ++r) {
            for (uint256 side = RULING_ATTENDED; side <= RULING_ABSENT; ++side) {
                if (appealContribution[staker][r][side][msg.sender] == 0) continue;
                funded = true;
                appealContribution[staker][r][side][msg.sender] = 0;
            }
        }
        require(funded && amount > 0, NothingToClaim());
        (bool ok,) = to.call{value: amount}("");
        require(ok, TransferFailed(to, amount));
        emit AppealRewardClaimed(staker, msg.sender, to, amount);
    }

    /// @dev Kleros's dispute kit sends refunds and rewards here as plain ETH transfers.
    receive() external payable {}

    // ------------------------------------------------------------------ settlement

    /// @notice Split the staked pool equally between the attendees. Anyone can call it once the
    /// challenge window is over and no challenge is pending. Challenges whose match window ran
    /// out without a match are accepted here automatically.
    function releasePayouts() external whenListed nonReentrant {
        require(block.timestamp > challengeEndsAt, TooEarly());
        uint256 len = _challengers.length;
        for (uint256 i; i < len; ++i) {
            address s = _challengers[i];
            Challenge storage c = challenges[s];
            if (c.state == ChallengeState.Waiting && block.timestamp > c.matchEndsAt) _acceptUnmatched(s, c);
        }
        // challenges still in a Kleros case get one share set aside each; nothing may wait for a match
        uint256 open;
        for (uint256 i; i < len; ++i) {
            Challenge storage c = challenges[_challengers[i]];
            if (c.state == ChallengeState.Disputed) {
                c.shareHeld = true;
                ++open;
            }
        }
        require(pendingChallenges == open, ChallengesPending(pendingChallenges - open));

        uint256 pool = deposit * stakerCount;
        uint256 n = attendeeCount;
        uint256 share = pool / (n + open);
        payoutShare = share;
        heldBack = share * open;
        phase = Phase.Finalized;
        for (uint256 i; i < _attendees.length; ++i) {
            address a = _attendees[i];
            status[a] = Status.Paid;
            _payOrOwe(a, share);
        }
        for (uint256 i; i < len; ++i) {
            address s = _challengers[i];
            if (challenges[s].shareHeld) emit ShareHeldBack(s, share);
        }
        emit Finalized(stakerCount, n, pool, share);
    }

    /// @notice Event cancelled: refund every registered staker their deposit.
    function cancel() external onlyOwner whenOpen beforeDeadline {
        uint256 pool = deposit * stakerCount;
        uint256 bal = token.balanceOf(address(this));
        require(bal >= pool + owedTotal, InsufficientBalance(pool + owedTotal, bal));

        uint256 count = stakerCount;
        phase = Phase.Cancelled;
        uint256 len = _stakers.length;
        for (uint256 i; i < len; ++i) {
            address s = _stakers[i];
            if (status[s] != Status.Staker) continue; // skip rejected / withdrawn
            status[s] = Status.Paid;
            _payOrOwe(s, deposit);
        }
        emit Cancelled(count, deposit);
    }

    /// @notice Collect a USDC payout that could not be delivered, to any address you choose.
    function claim(address to) external {
        require(to != address(0), ZeroAddress());
        uint256 amount = owed[msg.sender];
        require(amount > 0, NothingToClaim());
        owed[msg.sender] = 0;
        owedTotal -= amount;
        _sendOrRevert(to, amount);
        emit Claimed(msg.sender, to, amount);
    }

    /// @notice Collect ETH (a challenge deposit or winnings) that could not be sent to you.
    function withdrawEth(address payable to) external nonReentrant {
        require(to != address(0) && to != address(this), ZeroAddress());
        uint256 amount = ethOwed[msg.sender];
        require(amount > 0, NothingToClaim());
        ethOwed[msg.sender] = 0;
        (bool ok,) = to.call{value: amount}("");
        require(ok, TransferFailed(to, amount));
    }

    /// @notice Safety net if the organiser never posts the list: after `claimDeadline`, a registered
    /// staker can take their own deposit back, to any address they choose.
    function emergencyWithdraw(address to) external whenOpen {
        require(to != address(0), ZeroAddress());
        require(block.timestamp > claimDeadline, TooEarly());
        require(status[msg.sender] == Status.Staker, NotAStaker(msg.sender));
        status[msg.sender] = Status.Paid;
        stakerCount -= 1;
        _sendOrRevert(to, deposit);
        emit EmergencyWithdrawn(msg.sender, deposit);
    }

    /// @notice After settlement, recover rounding dust and stray transfers. Unclaimed payouts stay.
    function sweep(address to) external onlyOwner {
        require(phase == Phase.Finalized || phase == Phase.Cancelled, NotSettled());
        uint256 amount = spare();
        _sendOrRevert(to, amount);
        emit Swept(to, amount);
    }

    // ------------------------------------------------------------------ admin

    /// @notice Step 1 of 2: propose a new owner. Nothing changes until they call `acceptOwnership`.
    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), ZeroAddress());
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    /// @notice Step 2 of 2: the proposed owner accepts.
    function acceptOwnership() external {
        require(msg.sender == pendingOwner, NotPendingOwner());
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    // ------------------------------------------------------------------ internal

    function _addAttendee(address a) private {
        require(!attended[a], DuplicateAttendee(a));
        require(status[a] == Status.Staker, NotAStaker(a));
        attended[a] = true;
        _attendees.push(a);
        attendeeCount += 1;
        emit AttendeeAdded(a);
    }

    /// @dev A case still open at payout is settled: its set-aside share goes to the challenger if
    /// Kleros ruled they attended, otherwise it is split equally among everyone on the list.
    function _settleHeldShare(address staker, bool won) private {
        uint256 share = payoutShare;
        heldBack -= share;
        challenges[staker].shareHeld = false;
        if (won) {
            attended[staker] = true;
            _attendees.push(staker);
            attendeeCount += 1;
            status[staker] = Status.Paid;
            emit AttendeeAdded(staker);
            _payOrOwe(staker, share);
            return;
        }
        uint256 n = _attendees.length;
        uint256 each = share / n; // the rounding dust stays as spare
        emit HeldShareSplit(staker, n, each);
        for (uint256 i; i < n; ++i) _payOrOwe(_attendees[i], each);
    }

    /// @dev Nobody matched in time: the challenger counts as attended and gets their deposit back.
    function _acceptUnmatched(address staker, Challenge storage c) private {
        c.state = ChallengeState.Resolved;
        pendingChallenges -= 1;
        if (!attended[staker]) _addAttendee(staker);
        emit ChallengeResolved(staker, true, RULING_ATTENDED);
        _sendEth(staker, c.deposit);
    }

    function _disputeKit(IArbitratorV2 core) private view returns (IDisputeKitClassic) {
        return IDisputeKitClassic(core.disputeKits(disputeKitID));
    }

    /// @dev Withdraws from the dispute kit, per round and side, what Kleros owes this contract.
    /// The kit deployed on Arbitrum One takes a round argument; newer versions take none and pay
    /// every round at once, in which case the amount is spread over the rounds by what was paid.
    function _collectAppealFunds(address staker) private {
        Challenge storage c = challenges[staker];
        require(c.state == ChallengeState.Resolved && c.matcher != address(0), WrongChallengeState(staker));
        require(!appealFundsCollected[staker], NothingToClaim());
        appealFundsCollected[staker] = true;
        address kit = address(_disputeKit(disputeResolver.arbitrator()));
        uint256 id = c.arbitratorDisputeID;
        uint256 rounds = appealRounds[staker];
        uint256 total;
        for (uint256 side = RULING_ATTENDED; side <= RULING_ABSENT; ++side) {
            for (uint256 r; r < rounds; ++r) {
                if (appealPaid[staker][r][side] == 0) continue;
                uint256 before = address(this).balance;
                (bool ok,) = kit.call(abi.encodeWithSignature("withdrawFeesAndRewards(uint256,address,uint256,uint256)", id, address(this), r, side));
                if (ok) {
                    uint256 got = address(this).balance - before;
                    appealReturned[staker][r][side] = got;
                    total += got;
                    continue;
                }
                (ok,) = kit.call(abi.encodeWithSignature("withdrawFeesAndRewards(uint256,address,uint256)", id, address(this), side));
                require(ok, AppealWithdrawFailed());
                uint256 lump = address(this).balance - before;
                total += lump;
                uint256 paidAll;
                for (uint256 q = r; q < rounds; ++q) paidAll += appealPaid[staker][q][side];
                for (uint256 q = r; q < rounds; ++q) appealReturned[staker][q][side] = (lump * appealPaid[staker][q][side]) / paidAll;
                break;
            }
        }
        emit AppealFundsCollected(staker, total);
    }

    /// @dev The Kleros dispute template (JSON). Only `eventName` and `policyURI` come from the
    /// deployer; the guest supplies nothing, so the JSON cannot be broken from outside.
    function _disputeTemplate(address staker) private view returns (string memory) {
        string memory who = _toHex(staker);
        string memory head = string.concat(
            '{"title":"', eventName, ': did this guest attend?",',
            '"description":"Guests of ', eventName, ' staked a refundable deposit. Everyone the organiser lists as attending splits the pool; guests left off the list lose their deposit. Wallet ', who,
            ' was left off the list and says they attended. The organiser (or someone else) disagrees.",'
        );
        string memory question = string.concat(
            '"question":"Did the person who registered with wallet ', who, ' attend ', eventName, '?",',
            '"answers":[{"id":"0x1","title":"Yes, attended","description":"This wallet is added to the attendees and paid like everyone who attended."},',
            '{"id":"0x2","title":"No, did not attend","description":"This wallet stays off the attendance list and forfeits its deposit."}],'
        );
        string memory tail = string.concat(
            '"policyURI":"', policyURI, '",',
            '"arbitratorChainID":"', _toDecimal(block.chainid), '",',
            '"arbitratorAddress":"', _toHex(address(disputeResolver.arbitrator())), '",'
        );
        return string.concat(
            head, question, tail,
            '"aliases":{"Guest":"', who, '"},',
            '"category":"Event attendance","lang":"en_US","specification":"KIP00","version":"1.0"}'
        );
    }

    function _toHex(address a) private pure returns (string memory) {
        bytes memory digits = "0123456789abcdef";
        bytes memory out = new bytes(42);
        out[0] = "0";
        out[1] = "x";
        uint160 v = uint160(a);
        for (uint256 i = 41; i > 1; --i) {
            out[i] = digits[v & 0xf];
            v >>= 4;
        }
        return string(out);
    }

    function _toDecimal(uint256 v) private pure returns (string memory) {
        if (v == 0) return "0";
        uint256 len;
        for (uint256 t = v; t != 0; t /= 10) ++len;
        bytes memory out = new bytes(len);
        for (; v != 0; v /= 10) out[--len] = bytes1(uint8(48 + (v % 10)));
        return string(out);
    }

    function _transfer(address to, uint256 amount) private returns (bool) {
        (bool ok, bytes memory data) =
            address(token).call(abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
        if (!ok) return false;
        if (data.length == 0) return true; // tokens that return nothing
        // only a well-formed `true` counts; anything else is a failure, never a revert
        return data.length >= 32 && abi.decode(data, (uint256)) == 1;
    }

    /// @dev Used where the caller can fix the problem and retry (refunds, claims, sweep).
    function _sendOrRevert(address to, uint256 amount) private {
        // sending to this contract would only turn the money into "spare"
        require(to != address(0) && to != address(this), ZeroAddress());
        if (amount == 0) return;
        require(_transfer(to, amount), TransferFailed(to, amount));
    }

    /// @dev Used in batch payouts: one failing recipient must not block everyone else.
    function _payOrOwe(address to, uint256 amount) private {
        if (amount == 0) return;
        if (_transfer(to, amount)) {
            emit Payout(to, amount);
        } else {
            owed[to] += amount;
            owedTotal += amount;
            emit PayoutFailed(to, amount);
        }
    }

    /// @dev ETH to a guest or matcher; a wallet that refuses it can collect it later with `withdrawEth`.
    function _sendEth(address to, uint256 amount) private {
        if (amount == 0) return;
        bool ok;
        // no return data is copied, so a recipient cannot blow up the gas of a batch
        assembly ("memory-safe") {
            ok := call(30000, to, amount, 0, 0, 0, 0)
        }
        if (!ok) {
            ethOwed[to] += amount;
            emit EthOwed(to, amount);
        }
    }
}
