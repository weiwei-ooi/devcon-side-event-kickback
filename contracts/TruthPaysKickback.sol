// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Kleros Court v1 arbitrator (KlerosLiquid, ERC-792) on Ethereum mainnet
/// (0x988b3A538b618C7A603e1c11Ab82Cd16dbE28069): the fee and the appeal views this contract reads.
/// Extra data = abi.encode(uint256 subcourtID, uint256 minJurors). Periods: 0 evidence, 1 commit,
/// 2 vote, 3 appeal, 4 execution. Anyone can move a case on with `passPeriod(disputeID)` and, in
/// the execution period, deliver the ruling with `executeRuling(disputeID)`.
interface IKlerosLiquid {
    function arbitrationCost(bytes calldata extraData) external view returns (uint256 cost);
    function appealCost(uint256 disputeID, bytes calldata extraData) external view returns (uint256 cost);
    function appealPeriod(uint256 disputeID) external view returns (uint256 start, uint256 end);
    function currentRuling(uint256 disputeID) external view returns (uint256 ruling);
}

/// @notice Kleros's general-purpose Dispute Resolver (ArbitrableProxy) on Ethereum mainnet
/// (0x4b89e798b10478a839ea0abcf86c4b94a3c782a4). It is the arbitrable party in KlerosLiquid: it
/// opens the case, takes the evidence and the appeal crowdfunding, and records the final ruling.
/// Besides what this contract calls, people use it directly from their own wallets:
///  - `submitEvidence(uint256 localDisputeID, string evidenceURI)`: ERC-1497 evidence, refused once ruled;
///  - `fundAppeal(uint256 localDisputeID, uint256 ruling) payable`: appeal crowdfunding, surplus refunded;
///  - `withdrawFeesAndRewardsForAllRounds(uint256 localDisputeID, address contributor, uint256[] rulings)`:
///    appeal refunds and rewards, paid to the contributor once the case is ruled.
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

/// @title TruthPaysKickback (v6)
/// @notice Kickback-style refundable ETH deposits for an IRL event on Ethereum mainnet, with
/// attendance challenges decided by Kleros Court.
///
/// Flow
///  1. While the contract is Open, guests send `depositAmount` of ETH to this contract on Ethereum
///     mainnet: a plain transfer to its address (`receive`) or a call to `deposit()`, which do the
///     same thing and emit `Deposited(from, amount)`. Each guest pastes the tx link into their Luma
///     registration. Both refuse ETH once the attendance list is posted or the event is cancelled,
///     so ETH sent too late stays in the guest's wallet.
///  2. Off-chain, the organiser checks each deposit (scripts/verify-deposits.mjs reads the
///     `Deposited` events) and curates on Luma. Approved guests are added with `registerStakers`.
///     Declined guests (bots, wrong audience) get exactly `depositAmount` back with
///     `rejectAndRefund`, in one transaction for the whole batch. A registered staker who drops
///     out can be rejected the same way while the contract is Open.
///  3. After the event starts, the organiser publishes who checked in with `postAttendance`.
///  4. Challenge window (1 day): a registered staker left off the list who says they attended
///     calls `challenge`, paying a challenge deposit equal to the Kleros arbitration cost
///     (`challengeDeposit()`, read from KlerosLiquid).
///  5. Match window (1 day from each challenge): anyone (usually the organiser) who disagrees
///     calls `matchChallenge` with the same deposit. The Kleros fee is paid from the two deposits:
///     the contract opens the case with `disputeResolver.createDispute{value: fee}(extraData,
///     metaEvidenceURI, 2)` and stores Kleros's case number (`arbitratorDisputeID`, shown at
///     court.kleros.io/cases/<id>) and the Dispute Resolver's own number for it (`localDisputeID`).
///     Ruling options: 1 = attended, 2 = did not attend; 0 = refused to arbitrate, which counts
///     like "did not attend". If nobody matches, the challenger counts as attended and gets their
///     deposit back.
///  5b. Evidence and appeals go to the Dispute Resolver directly, from each person's own wallet, so
///     Kleros shows the real sender and pays appeal refunds and rewards straight back to them: no
///     appeal money passes through this contract. Evidence: `submitEvidence(localDisputeID,
///     "/ipfs/<cid>/<file>.json")`. Appeals: `fundAppeal(localDisputeID, side)`; contributors
///     collect with `withdrawFeesAndRewardsForAllRounds(localDisputeID, contributor, [1, 2])`.
///     `appealStatus` shows the deadlines and the amount each side needs. Every case uses the same
///     static metaevidence (`metaEvidenceURI`, an ERC-1497 file whose fileURI is the juror policy,
///     `policyURI`). This contract submits no evidence: jurors learn which wallet a case is about
///     from the `Challenged` and `ChallengeMatched` events and from the parties' evidence.
///     Only the final ruling counts: the Dispute Resolver records it when KlerosLiquid delivers it
///     after the last appeal period (`passPeriod`, then `executeRuling`, both open to anyone),
///     including its override when only one side funded the last appeal (that side wins).
///  6. Once the challenge window is over and no challenge is still waiting for a match, anyone
///     can call `releasePayouts`. The staked pool (deposit x stakers) is split into equal shares,
///     one per attendee plus one per challenger still in a Kleros case: attendees are paid at
///     once and one share is set aside per open case, so a dispute (or an appeal) cannot hold
///     everyone's money. When a case is settled, its set-aside amount goes to the challenger if
///     Kleros rules they attended. Otherwise it is split into equal parts, one per attendee and
///     one per case still open: attendees are paid their part and each open case's set-aside
///     amount grows by one part. Everyone who ends up on the list therefore receives the same
///     total, whatever order the cases settle in.
///     A payment that fails (a wallet contract that refuses ETH, or needs more than `PAYOUT_GAS`)
///     does not block the others: the amount is kept in `owed` for that wallet to `claim` later,
///     to any address it chooses.
///  7. ETH nobody is owed (rounding dust, overpayments, stray or unregistered deposits) can be
///     returned with `refund` or swept after settlement with `sweep`, never anything in `reserved()`.
///
/// ETH accounting
///  One balance holds everything: the staked pool, the set-aside shares (`heldBack`), the
///  challenge money (`challengeEscrow`) and payments waiting to be claimed (`owedTotal`).
///  `reserved()` counts all of it, so `refund`, `sweep` and the refund of an unregistered payer can
///  only ever move truly spare ETH. Deposits are counted in total, not per wallet:
///  `registerStakers` only checks that the balance covers every staker, so the organiser must only
///  register wallets whose own deposit the verify script found.
///
/// Reentrancy
///  Payments call out with ETH, so every function that sends ETH or relies on the balance is
///  `nonReentrant` (checked first, so a reentrant call always fails with `Reentrancy`) and updates
///  its state before sending. Batch payments give the recipient at most `PAYOUT_GAS` and copy no
///  return data. `deposit`/`receive` change no state (they only emit an event), so a recipient that
///  deposits again during a refund only adds spare ETH. Views such as `spare()` can be off in the
///  middle of a batch; read them between transactions.
///
/// Safety nets
///  - `cancel` refunds every registered staker if the event is called off (before the list is posted).
///  - If the organiser never posts the list (lost key), every registered staker can take their
///    own deposit back with `emergencyWithdraw` once `claimDeadline` has passed. Posting is only
///    possible up to `claimDeadline`, so the two can never race. Once the list is posted the
///    payout is permissionless, so the organiser cannot hold it back.
///  - Ownership changes need the new owner to accept, so a typo cannot lock the contract.
contract TruthPaysKickback {
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
    error NotAppealable(address staker);
    error ZeroDeposit();
    error NotEnoughGas();

    // ------------------------------------------------------------------ events
    event Deposited(address indexed from, uint256 amount);
    event StakerRegistered(address indexed staker);
    event Rejected(address indexed wallet, uint256 refunded);
    event AttendancePosted(uint256 attendees, uint256 challengeEndsAt);
    event AttendeeAdded(address indexed attendee);
    event Challenged(address indexed staker, uint256 deposit, uint256 matchEndsAt);
    event ChallengeMatched(address indexed staker, address indexed matcher, uint256 arbitratorDisputeID, uint256 localDisputeID);
    event ChallengeResolved(address indexed staker, bool attended, uint256 ruling);
    /// @notice A share of the pool or a deposit refund reached `to` (challenge money is not logged here).
    event Payout(address indexed to, uint256 amount);
    /// @notice A payment (share, refund or challenge money) could not be delivered: it waits in `owed`.
    event PayoutFailed(address indexed to, uint256 amount);
    event Claimed(address indexed account, address indexed to, uint256 amount);
    event Finalized(uint256 stakers, uint256 attendees, uint256 pool, uint256 share);
    event ShareHeldBack(address indexed staker, uint256 amount);
    event HeldShareSplit(address indexed staker, uint256 attendees, uint256 openCases, uint256 each);
    event Cancelled(uint256 stakers, uint256 refundedEach);
    event EmergencyWithdrawn(address indexed staker, uint256 amount);
    event Refunded(address indexed to, uint256 amount);
    event Swept(address indexed to, uint256 amount);
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
        Disputed, // matched: a Kleros case is open
        Resolved
    }

    struct Challenge {
        ChallengeState state;
        address matcher;
        uint64 matchEndsAt;
        uint256 deposit; // ETH paid by each side
        uint256 arbitratorDisputeID; // Kleros's case number (KlerosLiquid)
        uint256 localDisputeID; // the case's number inside the Dispute Resolver: evidence and appeals use it
        uint256 arbitrationPaid; // ETH spent on the Kleros fee
        // ETH set aside because the case was still open at payout (0 if none): one share, plus one
        // part of every case lost since. Always > 0 while set aside (a share is at least `depositAmount`).
        uint256 heldShare;
    }

    /// @notice Kleros settings, passed to the constructor as one struct.
    struct Arbitration {
        IArbitrableProxy disputeResolver;
        bytes extraData; // abi.encode(uint256 subcourtID, uint256 minJurors), e.g. General Court (0), 3 jurors
        string metaEvidenceURI; // ERC-1497 metaevidence for every case, e.g. /ipfs/Qm.../metaevidence.json
        string policyURI; // the attendance policy jurors apply (the metaevidence's fileURI), e.g. /ipfs/Qm...
    }

    /// @notice Ruling options for a Kleros attendance case (0 = refused to arbitrate).
    uint256 public constant RULING_ATTENDED = 1;
    uint256 public constant RULING_ABSENT = 2;
    uint256 public constant RULING_OPTIONS = 2;
    uint256 public constant CHALLENGE_PERIOD = 1 days;
    uint256 public constant MATCH_PERIOD = 1 days;
    /// @notice Minimum time between the event start and the deadline, so a late list is still possible.
    uint256 public constant MIN_SETTLEMENT_WINDOW = 7 days;
    /// @notice Gas a batch payment may use in the recipient's wallet. A plain wallet needs none. A
    /// Safe (proxy + `SafeReceived` event) or a common smart account (ERC-4337 proxies, Argent)
    /// needs well under 20,000, more than the 2,300 of `transfer` since cold storage reads got
    /// pricier. 100,000 leaves a wide margin for heavier wallets, while a hostile recipient can
    /// waste at most 100,000 gas per payment, so a batch of 150 still fits easily in a block.
    /// A wallet that needs more is not lost: its payment waits in `owed` for `claim`, which
    /// forwards all the gas the caller sends.
    uint256 public constant PAYOUT_GAS = 100_000;

    /// @notice The deposit per guest, in wei (0.01 ETH = 10000000000000000).
    uint256 public immutable depositAmount;
    /// @notice `postAttendance` is only possible from this time (unix seconds): no accidental early payout.
    uint256 public immutable eventStart;
    /// @notice Deadline to post the attendance list. After it, if still open, stakers can withdraw their own deposit.
    uint256 public immutable claimDeadline;
    /// @notice Kleros's Dispute Resolver (ArbitrableProxy): opens cases, takes evidence and appeals, records rulings.
    IArbitrableProxy public immutable disputeResolver;
    /// @notice Kleros Court (KlerosLiquid), read from the Dispute Resolver at deployment.
    IKlerosLiquid public immutable arbitrator;
    bytes public arbitratorExtraData;
    string public metaEvidenceURI;
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
    uint256 public pendingChallenges; // waiting for a match, or in a Kleros case
    /// @notice ETH held for challenges: the challenger's deposit while waiting for a match, then what
    /// is left of both deposits after the Kleros fee until the case is settled.
    uint256 public challengeEscrow;
    /// @notice The per-attendee payout, set by `releasePayouts`. A part of every Kleros case lost
    /// after payout is paid on top (see `_settleHeldShare`).
    uint256 public payoutShare;
    /// @notice ETH set aside for challengers still in a Kleros case: the sum of their `heldShare`.
    uint256 public heldBack;

    /// @notice Payments (shares, refunds, challenge money) that could not be delivered, waiting for `claim`.
    mapping(address => uint256) public owed;
    uint256 public owedTotal;

    uint256 private _locked = 1;

    // ------------------------------------------------------------------ setup
    constructor(
        uint256 depositAmount_,
        string memory eventName_,
        address owner_,
        uint256 eventStart_,
        uint256 claimDeadline_,
        Arbitration memory arbitration_
    ) {
        require(depositAmount_ > 0, ZeroDeposit());
        require(owner_ != address(0), ZeroAddress());
        require(address(arbitration_.disputeResolver) != address(0), ZeroAddress());
        require(claimDeadline_ >= eventStart_ + MIN_SETTLEMENT_WINDOW, BadTimes());
        // reverts if the address is not a Dispute Resolver
        IKlerosLiquid court = arbitration_.disputeResolver.arbitrator();
        require(address(court) != address(0), ZeroAddress());
        depositAmount = depositAmount_;
        eventName = eventName_;
        owner = owner_;
        eventStart = eventStart_;
        claimDeadline = claimDeadline_;
        disputeResolver = arbitration_.disputeResolver;
        arbitrator = court;
        arbitratorExtraData = arbitration_.extraData;
        metaEvidenceURI = arbitration_.metaEvidenceURI;
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

    // ------------------------------------------------------------------ deposits

    /// @notice A plain ETH transfer to the contract address is a deposit (same as `deposit()`).
    /// Accepted only while the contract is Open.
    receive() external payable {
        _deposit();
    }

    /// @notice Pay a deposit: send `depositAmount` of ETH with this call. Accepted only while Open.
    function deposit() external payable {
        _deposit();
    }

    // ------------------------------------------------------------------ views

    /// @notice ETH that must stay in the contract: the staked pool until paid out (then the shares
    /// set aside for open Kleros cases), unclaimed payments and the challenge money.
    function reserved() public view returns (uint256) {
        bool poolHeld = phase == Phase.Open || phase == Phase.Listed;
        return (poolHeld ? depositAmount * stakerCount : heldBack) + owedTotal + challengeEscrow;
    }

    /// @notice ETH in the contract that nobody is owed (unregistered or declined-not-yet-refunded
    /// deposits, overpayments, stray transfers, rounding dust).
    function spare() public view returns (uint256) {
        uint256 bal = address(this).balance;
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
        return (depositAmount * stakerCount) / attendeeCount_;
    }

    /// @notice ETH needed to open a challenge right now: the Kleros arbitration cost. Matching an
    /// open challenge takes that challenge's own deposit (`challenges(staker).deposit`).
    function challengeDeposit() public view returns (uint256) {
        return arbitrator.arbitrationCost(arbitratorExtraData);
    }

    /// @notice Where the Kleros case on `staker`'s challenge stands, for an appeal. Funders pay the
    /// Dispute Resolver directly, from their own wallet:
    /// `disputeResolver.fundAppeal(challenges(staker).localDisputeID, side)`. The amounts follow the
    /// Dispute Resolver's own rule: the side the jurors voted for pays the appeal cost plus the
    /// winner stake (1x today) until `end`; any other side (both, after a tie or a refusal) pays the
    /// cost plus the loser stake (2x today) and only until `loserEnd`. Funding must happen strictly
    /// before the deadline. What each side has raised so far is in the Dispute Resolver's
    /// `Contribution` and `RulingFunded` events.
    /// @return ruling The jurors' current vote (0 tied or refused, 1 attended, 2 absent).
    /// @return start Start of the appeal period (0 if the case is not in its appeal period).
    /// @return end End of the appeal period.
    /// @return loserEnd Until when a side the jurors did not vote for can still be funded.
    /// @return costAttended Total needed to fund the "attended" side this round.
    /// @return costAbsent Total needed to fund the "did not attend" side this round.
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
        (uint256 winnerMul, uint256 loserMul, uint256 loserPeriodMul, uint256 denominator) = disputeResolver.getMultipliers();
        loserEnd = start + ((end - start) * loserPeriodMul) / denominator;
        uint256 cost = arbitrator.appealCost(id, arbitratorExtraData);
        uint256 winner = _withStake(cost, winnerMul, denominator);
        uint256 loser = _withStake(cost, loserMul, denominator);
        costAttended = ruling == RULING_ATTENDED ? winner : loser;
        costAbsent = ruling == RULING_ABSENT ? winner : loser;
    }

    // ------------------------------------------------------------------ curation (organiser)

    /// @notice Record wallets whose deposit was verified off-chain and that the organiser approved.
    function registerStakers(address[] calldata wallets) external nonReentrant onlyOwner whenOpen {
        for (uint256 i; i < wallets.length; ++i) {
            address s = wallets[i];
            // this contract can never be paid (its own receive refuses ETH after the list), so never a staker
            require(s != address(0) && s != address(this), ZeroAddress());
            Status st = status[s];
            // a rejected (refunded) wallet may come back if the organiser approves it after a new deposit
            require(st == Status.None || st == Status.Rejected, AlreadyRegistered(s));
            status[s] = Status.Staker;
            _stakers.push(s);
            emit StakerRegistered(s);
        }
        stakerCount += wallets.length;
        uint256 bal = address(this).balance;
        uint256 r = reserved();
        require(bal >= r, InsufficientBalance(r, bal));
    }

    /// @notice Decline guests and send each one exactly `depositAmount` back, to their own wallet.
    /// Works for verified-but-declined payers (never registered) and, while open, for registered
    /// stakers who drop out. Unregistered payers can also be refunded later (late payers). The
    /// refund always goes to the rejected wallet itself; if that payment fails (a wallet contract
    /// that refuses ETH) the amount is kept for them to `claim` to another address, so one bad
    /// wallet never blocks the batch.
    function rejectAndRefund(address[] calldata wallets) external nonReentrant onlyOwner {
        for (uint256 i; i < wallets.length; ++i) {
            address w = wallets[i];
            require(w != address(0) && w != address(this), ZeroAddress());
            Status st = status[w];
            if (st == Status.Staker && phase == Phase.Open) {
                stakerCount -= 1; // their deposit leaves the pool and goes back to them
            } else {
                require(st == Status.None, CannotReject(w));
                // an unregistered payer can only be refunded from money nobody else is owed
                require(spare() >= depositAmount, InsufficientBalance(reserved() + depositAmount, address(this).balance));
            }
            status[w] = Status.Rejected;
            emit Rejected(w, depositAmount);
            _payOrOwe(w, depositAmount);
        }
    }

    /// @notice Return an overpayment or a stray transfer. Only spare ETH can be refunded: never the
    /// staked pool, set-aside shares, challenge money or unclaimed payments. Allowed in every phase.
    function refund(address to, uint256 amount) external nonReentrant onlyOwner {
        require(amount <= spare(), InsufficientBalance(reserved() + amount, address(this).balance));
        emit Refunded(to, amount);
        _sendOrRevert(to, amount);
    }

    // ------------------------------------------------------------------ attendance

    /// @notice Publish the registered stakers who checked in. Opens the 1-day challenge window.
    /// From then on deposits are refused.
    /// @param list Registered stakers who checked in at the venue (no duplicates).
    /// @param expectedShare The per-attendee amount (wei) the organiser saw and confirmed in the console.
    function postAttendance(address[] calldata list, uint256 expectedShare)
        external
        nonReentrant
        onlyOwner
        whenOpen
        beforeDeadline
    {
        require(block.timestamp >= eventStart, TooEarly());
        require(list.length > 0, NoAttendees());
        uint256 bal = address(this).balance;
        uint256 r = reserved();
        require(bal >= r, InsufficientBalance(r, bal));
        uint256 share = (depositAmount * stakerCount) / list.length;
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
    function addAttendees(address[] calldata list) external nonReentrant onlyOwner whenListed {
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
                challengeEscrow -= c.deposit;
                emit ChallengeResolved(a, true, RULING_ATTENDED);
                _send(a, c.deposit);
            }
        }
    }

    // ------------------------------------------------------------------ challenges (Kleros)

    /// @notice A registered staker left off the list says they attended. Pay `challengeDeposit()` in ETH
    /// (any extra is sent back).
    function challenge() external payable nonReentrant whenListed {
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
        challengeEscrow += cost;
        emit Challenged(msg.sender, cost, c.matchEndsAt);
        if (msg.value > cost) _send(msg.sender, msg.value - cost);
    }

    /// @notice Disagree with a challenge: match its deposit within 1 day. This opens a Kleros case
    /// through the Dispute Resolver (any extra ETH is sent back).
    function matchChallenge(address staker) external payable nonReentrant whenListed {
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
        challengeEscrow = challengeEscrow + c.deposit - cost;
        // KlerosLiquid keeps everything sent with a case, so send exactly the fee
        uint256 id = disputeResolver.createDispute{value: cost}(arbitratorExtraData, metaEvidenceURI, RULING_OPTIONS);
        uint256 localID = disputeResolver.externalIDtoLocalID(id);
        c.arbitratorDisputeID = id;
        c.localDisputeID = localID;
        emit ChallengeMatched(staker, msg.sender, id, localID);
        if (msg.value > c.deposit) _send(msg.sender, msg.value - c.deposit);
    }

    /// @notice Settle a challenge once it can be: unmatched after its match window (counts as
    /// attended), or ruled by Kleros. Only the final ruling counts: the one the Dispute Resolver
    /// records after the last appeal period. A refusal to arbitrate (0) keeps the guest off the
    /// list, like "did not attend", and splits what is left of the challenge deposits in half.
    /// Anyone can call it.
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
            uint256 remaining = 2 * c.deposit - c.arbitrationPaid;
            challengeEscrow -= remaining;

            bool won = ruling == RULING_ATTENDED;
            if (won && !attended[staker] && phase == Phase.Listed) _addAttendee(staker);
            emit ChallengeResolved(staker, won, ruling);
            if (c.heldShare > 0) _settleHeldShare(staker, c, won);

            if (won) {
                _send(staker, remaining);
            } else if (ruling == RULING_ABSENT) {
                _send(c.matcher, remaining);
            } else {
                // refused to arbitrate: both sides get half back
                _send(staker, remaining / 2);
                _send(c.matcher, remaining - remaining / 2);
            }
        }
    }

    // ------------------------------------------------------------------ settlement

    /// @notice Split the staked pool equally between the attendees. Anyone can call it once the
    /// challenge window is over and no challenge is waiting for a match. Challenges whose match
    /// window ran out without a match are accepted here automatically; each challenge still in a
    /// Kleros case gets one share set aside until it is settled.
    function releasePayouts() external nonReentrant whenListed {
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
            if (challenges[_challengers[i]].state == ChallengeState.Disputed) ++open;
        }
        require(pendingChallenges == open, ChallengesPending(pendingChallenges - open));

        // attendees and open cases are different registered stakers, so share >= depositAmount > 0
        uint256 pool = depositAmount * stakerCount;
        uint256 n = attendeeCount;
        uint256 share = pool / (n + open);
        payoutShare = share;
        heldBack = share * open;
        phase = Phase.Finalized;
        for (uint256 i; i < len; ++i) {
            address s = _challengers[i];
            Challenge storage c = challenges[s];
            if (c.state == ChallengeState.Disputed) {
                c.heldShare = share;
                emit ShareHeldBack(s, share);
            }
        }
        for (uint256 i; i < _attendees.length; ++i) {
            address a = _attendees[i];
            status[a] = Status.Paid;
            _payOrOwe(a, share);
        }
        emit Finalized(stakerCount, n, pool, share);
    }

    /// @notice Event cancelled: refund every registered staker their deposit.
    function cancel() external nonReentrant onlyOwner whenOpen beforeDeadline {
        uint256 bal = address(this).balance;
        uint256 r = reserved();
        require(bal >= r, InsufficientBalance(r, bal));

        uint256 count = stakerCount;
        phase = Phase.Cancelled;
        uint256 len = _stakers.length;
        for (uint256 i; i < len; ++i) {
            address s = _stakers[i];
            if (status[s] != Status.Staker) continue; // skip rejected / withdrawn
            status[s] = Status.Paid;
            _payOrOwe(s, depositAmount);
        }
        emit Cancelled(count, depositAmount);
    }

    /// @notice Collect a payment that could not be delivered (a share, a refund or challenge
    /// money), to any address you choose. All the gas you send is forwarded.
    function claim(address to) external nonReentrant {
        uint256 amount = owed[msg.sender];
        require(amount > 0, NothingToClaim());
        owed[msg.sender] = 0;
        owedTotal -= amount;
        emit Claimed(msg.sender, to, amount);
        _sendOrRevert(to, amount);
    }

    /// @notice Safety net if the organiser never posts the list: after `claimDeadline`, a registered
    /// staker can take their own deposit back, to any address they choose.
    function emergencyWithdraw(address to) external nonReentrant whenOpen {
        require(block.timestamp > claimDeadline, TooEarly());
        require(status[msg.sender] == Status.Staker, NotAStaker(msg.sender));
        status[msg.sender] = Status.Paid;
        stakerCount -= 1;
        emit EmergencyWithdrawn(msg.sender, depositAmount);
        _sendOrRevert(to, depositAmount);
    }

    /// @notice After settlement, recover rounding dust and stray transfers. Everything in
    /// `reserved()` (unclaimed payments, set-aside shares, challenge money) stays.
    function sweep(address to) external nonReentrant onlyOwner {
        require(phase == Phase.Finalized || phase == Phase.Cancelled, NotSettled());
        uint256 amount = spare();
        emit Swept(to, amount);
        _sendOrRevert(to, amount);
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

    /// @dev Deposits only emit an event: the verify script reads them, and the contract counts money in total.
    function _deposit() private {
        require(phase == Phase.Open, NotOpen());
        require(msg.value > 0, ZeroDeposit());
        emit Deposited(msg.sender, msg.value);
    }

    function _addAttendee(address a) private {
        require(!attended[a], DuplicateAttendee(a));
        require(status[a] == Status.Staker, NotAStaker(a));
        attended[a] = true;
        _attendees.push(a);
        attendeeCount += 1;
        emit AttendeeAdded(a);
    }

    /// @dev A case still open at payout is settled. If Kleros ruled the challenger attended, they get
    /// the case's whole set-aside amount. Otherwise that amount is split into equal parts, one per
    /// attendee and one per case still open: each attendee is paid one part and each open case's
    /// set-aside amount grows by one part. At every step each attendee has received, and each open
    /// case holds, the same total, so a later winner gets exactly what every attendee got, whatever
    /// order the cases settle in (up to rounding dust, which stays as spare).
    function _settleHeldShare(address staker, Challenge storage c, bool won) private {
        uint256 amount = c.heldShare;
        c.heldShare = 0;
        heldBack -= amount;
        if (won) {
            attended[staker] = true;
            _attendees.push(staker);
            attendeeCount += 1;
            status[staker] = Status.Paid;
            emit AttendeeAdded(staker);
            _payOrOwe(staker, amount);
            return;
        }
        uint256 n = _attendees.length;
        // after payout no challenge can wait for a match, so every pending challenge is an open case
        // with a share set aside (this one is already resolved and no longer counted)
        uint256 open = pendingChallenges;
        uint256 each = amount / (n + open); // n >= 1: the posted list is never empty
        emit HeldShareSplit(staker, n, open, each);
        if (open > 0) {
            uint256 grown;
            uint256 len = _challengers.length;
            for (uint256 i; i < len; ++i) {
                Challenge storage o = challenges[_challengers[i]];
                if (o.heldShare > 0) {
                    o.heldShare += each;
                    ++grown;
                }
            }
            heldBack += each * grown; // stays the sum of the open cases' heldShare
        }
        for (uint256 i; i < n; ++i) _payOrOwe(_attendees[i], each);
    }

    /// @dev Nobody matched in time: the challenger counts as attended and gets their deposit back.
    function _acceptUnmatched(address staker, Challenge storage c) private {
        c.state = ChallengeState.Resolved;
        pendingChallenges -= 1;
        challengeEscrow -= c.deposit;
        if (!attended[staker]) _addAttendee(staker);
        emit ChallengeResolved(staker, true, RULING_ATTENDED);
        _send(staker, c.deposit);
    }

    /// @dev `cost + cost * multiplier / denominator`, saturating like the Dispute Resolver's
    /// CappedMath (Kleros quotes a huge "non-payable" appeal cost when a case cannot be appealed further).
    function _withStake(uint256 cost, uint256 multiplier, uint256 denominator) private pure returns (uint256) {
        unchecked {
            uint256 product = cost * multiplier;
            if (cost != 0 && product / cost != multiplier) product = type(uint256).max;
            uint256 total = cost + product / denominator;
            return total < cost ? type(uint256).max : total;
        }
    }

    /// @dev Used in batches and for challenge money: one failing recipient must never block anyone
    /// else. The recipient gets at most PAYOUT_GAS and no return data is copied, so it cannot blow
    /// up the gas of the batch. A failed payment is kept in `owed` for `claim`.
    function _send(address to, uint256 amount) private returns (bool ok) {
        if (amount == 0) return true;
        assembly ("memory-safe") {
            ok := call(PAYOUT_GAS, to, amount, 0, 0, 0, 0)
        }
        if (!ok) {
            // A failure only counts if the recipient had its full PAYOUT_GAS. The EVM passes on at most
            // 63/64 of the gas left, so a caller who sent too little gas would leave less than
            // PAYOUT_GAS / 63 here: revert instead, so nobody can push payments into `owed` on purpose
            // (and gas estimation always finds a limit that gives every recipient its full allowance).
            require(gasleft() >= PAYOUT_GAS / 63, NotEnoughGas());
            owed[to] += amount;
            owedTotal += amount;
            emit PayoutFailed(to, amount);
        }
    }

    /// @dev A share of the pool or a deposit refund, logged with `Payout` when delivered.
    function _payOrOwe(address to, uint256 amount) private {
        if (amount == 0) return;
        if (_send(to, amount)) emit Payout(to, amount);
    }

    /// @dev Used where the caller picks the address and can retry (refund, claim, sweep, emergency
    /// withdrawal): all the gas is forwarded and a failure reverts.
    function _sendOrRevert(address to, uint256 amount) private {
        // sending to this contract would only turn the money into "spare"
        require(to != address(0) && to != address(this), ZeroAddress());
        if (amount == 0) return;
        bool ok;
        assembly ("memory-safe") {
            ok := call(gas(), to, amount, 0, 0, 0, 0)
        }
        require(ok, TransferFailed(to, amount));
    }
}
