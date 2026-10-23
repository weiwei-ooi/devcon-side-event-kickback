// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Minimal ERC-20 interface (USDC-compatible).
interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
}

/// @title GroundTruthKickback (v2)
/// @notice Kickback-style refundable deposits for an IRL event.
///
/// Flow
///  1. Guests send exactly `deposit` of `token` to this contract (plain ERC-20 transfer)
///     and paste the tx link into their Luma registration.
///  2. Off-chain, the organiser verifies each tx (scripts/verify-deposits.mjs) and curates on
///     Luma. Approved guests are added with `registerStakers`. Declined guests (bots, wrong
///     audience) get their deposit straight back with `rejectAndRefund`, in one transaction
///     for the whole batch. A registered staker who drops out can be rejected the same way.
///  3. After the event starts, the organiser calls `finalize` with the stakers who checked in.
///     The whole staked pool (deposit x stakers) is split equally among them. A transfer that
///     fails (e.g. a USDC-blocklisted wallet) does not block the others: that share is kept
///     for the attendee to `claim` later, to any address they choose.
///  4. Anything not owed to anyone (rounding dust, stray or excess transfers) can be refunded
///     or swept by the owner, but never the staked pool or unclaimed payouts.
///
/// Safety nets
///  - `cancel` refunds every registered staker if the event is called off.
///  - If the organiser never settles (lost key), every registered staker can take their own
///    deposit back with `emergencyWithdraw` once `claimDeadline` has passed. Settlement is
///    only possible up to `claimDeadline`, so the two can never race. Payers who were never
///    registered depend on the owner (`rejectAndRefund` / `refund`) to get their money back.
///  - Ownership changes need the new owner to accept, so a typo cannot lock the contract.
contract GroundTruthKickback {
    // ------------------------------------------------------------------ errors
    error NotOwner();
    error NotPendingOwner();
    error NotOpen();
    error NotSettled();
    error ZeroAddress();
    error BadTimes();
    error TooLate();
    error TooEarly();
    error AlreadyRegistered(address staker);
    error NotAStaker(address account);
    error CannotReject(address account);
    error DuplicateAttendee(address account);
    error NoAttendees();
    error ShareMismatch(uint256 expected, uint256 actual);
    error InsufficientBalance(uint256 required, uint256 available);
    error NothingToClaim();
    error TransferFailed(address to, uint256 amount);

    // ------------------------------------------------------------------ events
    event StakerRegistered(address indexed staker);
    event Rejected(address indexed wallet, uint256 refunded);
    event Payout(address indexed attendee, uint256 amount);
    event PayoutFailed(address indexed attendee, uint256 amount);
    event Claimed(address indexed attendee, address indexed to, uint256 amount);
    event Finalized(uint256 stakers, uint256 attendees, uint256 pool, uint256 share);
    event Cancelled(uint256 stakers, uint256 refundedEach);
    event EmergencyWithdrawn(address indexed staker, uint256 amount);
    event Refunded(address indexed to, uint256 amount);
    event Swept(address indexed to, uint256 amount);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    // ------------------------------------------------------------------ state
    enum Phase {
        Open,
        Finalized,
        Cancelled
    }

    enum Status {
        None,
        Staker,
        Paid,
        Rejected
    }

    IERC20 public immutable token;
    uint256 public immutable deposit;
    /// @notice `finalize` is only possible from this time (unix seconds): no accidental early payout.
    uint256 public immutable eventStart;
    /// @notice Settlement deadline. After it, if still unsettled, stakers can withdraw their own deposit.
    uint256 public immutable claimDeadline;
    /// @notice Minimum time between the event start and the deadline, so a late payout is still possible.
    uint256 public constant MIN_SETTLEMENT_WINDOW = 7 days;
    string public eventName;

    address public owner;
    address public pendingOwner;
    Phase public phase;

    mapping(address => Status) public status;
    address[] private _stakers;
    uint256 public stakerCount; // active stakers

    /// @notice Payouts that could not be delivered and are waiting for `claim`.
    mapping(address => uint256) public owed;
    uint256 public owedTotal;

    // ------------------------------------------------------------------ setup
    constructor(
        IERC20 token_,
        uint256 deposit_,
        string memory eventName_,
        address owner_,
        uint256 eventStart_,
        uint256 claimDeadline_
    ) {
        if (address(token_) == address(0) || owner_ == address(0)) revert ZeroAddress();
        if (claimDeadline_ < eventStart_ + MIN_SETTLEMENT_WINDOW) revert BadTimes();
        token = token_;
        deposit = deposit_;
        eventName = eventName_;
        owner = owner_;
        eventStart = eventStart_;
        claimDeadline = claimDeadline_;
        emit OwnershipTransferred(address(0), owner_);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier whenOpen() {
        if (phase != Phase.Open) revert NotOpen();
        _;
    }

    /// @dev Settlement (finalize/cancel) is only possible up to the deadline; after it, stakers exit themselves.
    modifier beforeDeadline() {
        if (block.timestamp > claimDeadline) revert TooLate();
        _;
    }

    // ------------------------------------------------------------------ views

    /// @notice USDC that must stay in the contract: the staked pool while open, plus unclaimed payouts.
    function reserved() public view returns (uint256) {
        return (phase == Phase.Open ? deposit * stakerCount : 0) + owedTotal;
    }

    /// @notice USDC in the contract that nobody is owed (stray/excess/declined-not-yet-refunded).
    function spare() public view returns (uint256) {
        uint256 bal = token.balanceOf(address(this));
        uint256 r = reserved();
        return bal > r ? bal - r : 0;
    }

    /// @notice All wallets ever registered (check `status` to see if still active / paid / rejected).
    function stakers() external view returns (address[] memory) {
        return _stakers;
    }

    /// @notice Preview the payout per attendee for a given attendee count.
    function previewShare(uint256 attendeeCount) external view returns (uint256) {
        if (attendeeCount == 0) return 0;
        return (deposit * stakerCount) / attendeeCount;
    }

    // ------------------------------------------------------------------ curation (organiser)

    /// @notice Record wallets whose deposit was verified off-chain and that the organiser approved.
    function registerStakers(address[] calldata wallets) external onlyOwner whenOpen {
        for (uint256 i; i < wallets.length; ++i) {
            address s = wallets[i];
            if (s == address(0)) revert ZeroAddress();
            Status st = status[s];
            // a rejected (refunded) wallet may come back if the organiser approves it after a new deposit
            if (st != Status.None && st != Status.Rejected) revert AlreadyRegistered(s);
            status[s] = Status.Staker;
            _stakers.push(s);
            emit StakerRegistered(s);
        }
        stakerCount += wallets.length;
        uint256 bal = token.balanceOf(address(this));
        if (bal < reserved()) revert InsufficientBalance(reserved(), bal);
    }

    /// @notice Decline guests and send each one exactly `deposit` back, to their own wallet.
    /// Works for verified-but-declined payers (never registered) and, while open, for registered
    /// stakers who drop out. Unregistered payers can also be refunded after settlement (late
    /// payers). The refund always goes to the rejected wallet itself; if that transfer fails
    /// (e.g. a blocklisted wallet) the amount is kept for them to `claim` to another address,
    /// so one bad wallet never blocks the batch.
    function rejectAndRefund(address[] calldata wallets) external onlyOwner {
        for (uint256 i; i < wallets.length; ++i) {
            address w = wallets[i];
            if (w == address(0)) revert ZeroAddress();
            Status st = status[w];
            if (st == Status.Staker && phase == Phase.Open) {
                stakerCount -= 1; // their deposit leaves the pool and goes back to them
            } else if (st == Status.None) {
                // an unregistered payer can only be refunded from money nobody else is owed
                if (spare() < deposit) revert InsufficientBalance(reserved() + deposit, token.balanceOf(address(this)));
            } else {
                revert CannotReject(w);
            }
            status[w] = Status.Rejected;
            emit Rejected(w, deposit);
            _payOrOwe(w, deposit);
        }
    }

    /// @notice Return an overpayment or a stray transfer. Only spare money can be refunded:
    /// never the staked pool or unclaimed payouts. Allowed before and after settlement.
    function refund(address to, uint256 amount) external onlyOwner {
        uint256 s = spare();
        if (amount > s) revert InsufficientBalance(reserved() + amount, token.balanceOf(address(this)));
        _sendOrRevert(to, amount);
        emit Refunded(to, amount);
    }

    // ------------------------------------------------------------------ settlement

    /// @notice Split the staked pool equally between registered stakers who attended.
    /// @param attendees Registered stakers who checked in at the venue (no duplicates).
    /// @param expectedShare The per-attendee amount the organiser saw and confirmed in the console.
    function finalize(address[] calldata attendees, uint256 expectedShare) external onlyOwner whenOpen beforeDeadline {
        if (block.timestamp < eventStart) revert TooEarly();
        uint256 n = attendees.length;
        if (n == 0) revert NoAttendees();

        uint256 pool = deposit * stakerCount;
        uint256 bal = token.balanceOf(address(this));
        if (bal < pool + owedTotal) revert InsufficientBalance(pool + owedTotal, bal);

        uint256 share = pool / n;
        if (share != expectedShare) revert ShareMismatch(expectedShare, share);
        uint256 count = stakerCount;
        phase = Phase.Finalized;

        for (uint256 i; i < n; ++i) {
            address a = attendees[i];
            Status st = status[a];
            if (st == Status.Paid) revert DuplicateAttendee(a);
            if (st != Status.Staker) revert NotAStaker(a);
            status[a] = Status.Paid;
            _payOrOwe(a, share);
        }

        emit Finalized(count, n, pool, share);
    }

    /// @notice Event cancelled: refund every registered staker their deposit.
    function cancel() external onlyOwner whenOpen beforeDeadline {
        uint256 pool = deposit * stakerCount;
        uint256 bal = token.balanceOf(address(this));
        if (bal < pool + owedTotal) revert InsufficientBalance(pool + owedTotal, bal);

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

    /// @notice Collect a payout that could not be delivered, to any address you choose.
    function claim(address to) external {
        if (to == address(0)) revert ZeroAddress();
        uint256 amount = owed[msg.sender];
        if (amount == 0) revert NothingToClaim();
        owed[msg.sender] = 0;
        owedTotal -= amount;
        _sendOrRevert(to, amount);
        emit Claimed(msg.sender, to, amount);
    }

    /// @notice Safety net if the organiser never settles: after `claimDeadline`, a registered
    /// staker can take their own deposit back, to any address they choose.
    function emergencyWithdraw(address to) external whenOpen {
        if (to == address(0)) revert ZeroAddress();
        if (block.timestamp <= claimDeadline) revert TooEarly();
        if (status[msg.sender] != Status.Staker) revert NotAStaker(msg.sender);
        status[msg.sender] = Status.Paid;
        stakerCount -= 1;
        _sendOrRevert(to, deposit);
        emit EmergencyWithdrawn(msg.sender, deposit);
    }

    /// @notice After settlement, recover rounding dust and stray transfers. Unclaimed payouts stay.
    function sweep(address to) external onlyOwner {
        if (phase == Phase.Open) revert NotSettled();
        uint256 amount = spare();
        _sendOrRevert(to, amount);
        emit Swept(to, amount);
    }

    // ------------------------------------------------------------------ admin

    /// @notice Step 1 of 2: propose a new owner. Nothing changes until they call `acceptOwnership`.
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    /// @notice Step 2 of 2: the proposed owner accepts.
    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    // ------------------------------------------------------------------ internal

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
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) return;
        if (!_transfer(to, amount)) revert TransferFailed(to, amount);
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
}
