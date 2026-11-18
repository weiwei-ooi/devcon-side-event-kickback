// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @dev ERC-792 arbitrable side, as KlerosLiquid calls it.
interface IArbitrableV1 {
    function rule(uint256 disputeID, uint256 ruling) external;
}

/// @dev ERC-792 arbitrator side, as the Dispute Resolver calls it.
interface IArbitratorV1 {
    function createDispute(uint256 choices, bytes calldata extraData) external payable returns (uint256 disputeID);
    function arbitrationCost(bytes calldata extraData) external view returns (uint256 cost);
    function appeal(uint256 disputeID, bytes calldata extraData) external payable;
    function appealCost(uint256 disputeID, bytes calldata extraData) external view returns (uint256 cost);
    function appealPeriod(uint256 disputeID) external view returns (uint256 start, uint256 end);
    function currentRuling(uint256 disputeID) external view returns (uint256 ruling);
}

/// @dev Test stand-in for KlerosLiquid (Kleros Court v1) on Ethereum mainnet, with the same ABI for
/// everything the contract, the console and the guest page use: `arbitrationCost` = fee per juror x
/// jurors from the extra data (abi.encode(subcourtID, minJurors), 3 jurors by default); a case keeps
/// all the ETH sent with it; `appealCost` = fee per juror x (2n + 1) for a round of n jurors, or the
/// huge NON_PAYABLE_AMOUNT once the General Court cannot grow further (`jurorsForCourtJump`);
/// `appeal` only from the arbitrable (the Dispute Resolver) during the appeal period, with a bigger
/// jury next round; `appealPeriod` is (0, 0) outside the appeal period; `passPeriod` moves the
/// appeal period on to execution once it is over; `executeRuling` (execution period only, once)
/// calls `rule(disputeID, currentRuling)` on the arbitrable. Jurors are not simulated: the test
/// hook `startAppealPeriod` records their vote and opens the appeal period, and `giveFinalRuling`
/// runs a case straight to its ruling.
contract MockKlerosLiquid is IArbitratorV1 {
    enum Period {
        evidence,
        commit,
        vote,
        appeal,
        execution
    }

    /// @dev Field order and types match KlerosLiquid's public `disputes(uint256)` getter.
    struct Dispute {
        uint96 subcourtID;
        address arbitrated;
        uint256 numberOfChoices;
        Period period;
        uint256 lastPeriodChange;
        uint256 drawsInRound;
        uint256 commitsInRound;
        bool ruled;
    }

    struct Votes {
        uint256 ruling; // the jurors' vote in the latest round (0 = tied or refused)
        uint256 jurors; // jurors in the latest round
        uint256 rounds;
        uint256 appealDuration;
    }

    uint256 public constant NON_PAYABLE_AMOUNT = (2 ** 256 - 2) / 2;
    uint256 public constant MIN_JURORS = 3;
    /// @dev Arbitrator-side IDs differ from the Dispute Resolver's local IDs, like on mainnet.
    uint256 public constant ID_OFFSET = 1000;
    /// @dev General Court timesPerPeriod (seconds): evidence 78 h, commit 162 h, vote 162 h, appeal 108 h.
    uint256[4] internal _times = [uint256(78 hours), 162 hours, 162 hours, 108 hours];

    uint256 public feeForJuror = 0.0054 ether; // 3 jurors = 0.0162 ETH, the General Court fee on 27 Oct 2026
    uint256 public jurorsForCourtJump = 511;
    uint256 public disputeCount;
    mapping(uint256 => Dispute) public disputes;
    mapping(uint256 => Votes) internal _votes;

    event DisputeCreation(uint256 indexed _disputeID, address indexed _arbitrable);
    event AppealPossible(uint256 indexed _disputeID, address indexed _arbitrable);
    event AppealDecision(uint256 indexed _disputeID, address indexed _arbitrable);
    event NewPeriod(uint256 indexed _disputeID, Period _period);

    // ---------------------------------------------------------------- test hooks

    function setFeeForJuror(uint256 fee) external {
        feeForJuror = fee;
    }

    /// @dev A round of this many jurors or more cannot be appealed in the General Court (NON_PAYABLE_AMOUNT).
    function setJurorsForCourtJump(uint256 n) external {
        jurorsForCourtJump = n;
    }

    /// @dev The jurors voted `ruling` (0 = tie or refusal); the appeal period runs `duration` seconds from now.
    function startAppealPeriod(uint256 id, uint256 ruling, uint256 duration) public {
        Dispute storage d = _existing(id);
        require(d.period < Period.appeal, "Not in a voting round.");
        require(ruling <= d.numberOfChoices, "Invalid ruling.");
        _votes[id].ruling = ruling;
        _votes[id].appealDuration = duration;
        _newPeriod(id, Period.appeal);
        emit AppealPossible(id, d.arbitrated);
    }

    /// @dev Shortcut: the jurors vote `ruling`, nobody appeals, and the ruling is delivered.
    function giveFinalRuling(uint256 id, uint256 ruling) external {
        startAppealPeriod(id, ruling, 0);
        passPeriod(id);
        executeRuling(id);
    }

    // ---------------------------------------------------------------- KlerosLiquid ABI

    function arbitrationCost(bytes calldata extraData) public view returns (uint256) {
        (, uint256 minJurors) = _decode(extraData);
        return feeForJuror * minJurors;
    }

    function createDispute(uint256 choices, bytes calldata extraData) external payable returns (uint256 id) {
        require(msg.value >= arbitrationCost(extraData), "Value is less than required arbitration fee.");
        (uint96 court, uint256 minJurors) = _decode(extraData);
        id = ID_OFFSET + disputeCount++;
        disputes[id] = Dispute(court, msg.sender, choices, Period.evidence, block.timestamp, minJurors, 0, false);
        _votes[id] = Votes(0, minJurors, 1, _times[3]);
        emit DisputeCreation(id, msg.sender);
    }

    function appealCost(uint256 id, bytes calldata) public view returns (uint256) {
        uint256 jurors = _votes[id].jurors;
        if (jurors >= jurorsForCourtJump) return NON_PAYABLE_AMOUNT; // the General Court has no parent
        return feeForJuror * (jurors * 2 + 1);
    }

    function appeal(uint256 id, bytes calldata extraData) external payable {
        Dispute storage d = _existing(id);
        require(msg.value >= appealCost(id, extraData), "Value is less than required appeal fee.");
        require(d.period == Period.appeal, "Incorrect period.");
        require(msg.sender == d.arbitrated, "Can only be called by the arbitrable contract.");
        Votes storage v = _votes[id];
        v.jurors = v.jurors * 2 + 1;
        v.rounds += 1;
        v.ruling = 0;
        d.drawsInRound = 0;
        d.commitsInRound = 0;
        emit AppealDecision(id, d.arbitrated);
        _newPeriod(id, Period.evidence);
    }

    function appealPeriod(uint256 id) external view returns (uint256 start, uint256 end) {
        Dispute storage d = disputes[id];
        if (d.period != Period.appeal) return (0, 0);
        return (d.lastPeriodChange, d.lastPeriodChange + _votes[id].appealDuration);
    }

    function currentRuling(uint256 id) public view returns (uint256) {
        return _votes[id].ruling;
    }

    /// @dev 0 Waiting, 1 Appealable, 2 Solved (like KlerosLiquid's DisputeStatus).
    function disputeStatus(uint256 id) external view returns (uint8) {
        Period p = disputes[id].period;
        if (p < Period.appeal) return 0;
        return p == Period.appeal ? 1 : 2;
    }

    /// @dev Only the appeal → execution step is modelled (earlier periods need jurors: use startAppealPeriod).
    function passPeriod(uint256 id) public {
        Dispute storage d = _existing(id);
        require(d.period == Period.appeal, "The jurors have not voted yet (test: startAppealPeriod).");
        require(block.timestamp - d.lastPeriodChange >= _votes[id].appealDuration, "The appeal period has not passed yet.");
        _newPeriod(id, Period.execution);
    }

    function executeRuling(uint256 id) public {
        Dispute storage d = _existing(id);
        require(d.period == Period.execution, "Incorrect period.");
        require(!d.ruled, "Ruling already executed.");
        d.ruled = true;
        IArbitrableV1(d.arbitrated).rule(id, currentRuling(id));
    }

    function getSubcourt(uint96) external view returns (uint256[] memory children, uint256[4] memory timesPerPeriod) {
        return (children, _times);
    }

    /// @dev Not in KlerosLiquid's ABI: the number of rounds so far, for tests.
    function rounds(uint256 id) external view returns (uint256) {
        return _votes[id].rounds;
    }

    // ---------------------------------------------------------------- internal

    function _existing(uint256 id) internal view returns (Dispute storage d) {
        d = disputes[id];
        require(d.arbitrated != address(0), "No such dispute.");
    }

    function _newPeriod(uint256 id, Period p) internal {
        disputes[id].period = p;
        disputes[id].lastPeriodChange = block.timestamp;
        emit NewPeriod(id, p);
    }

    /// @dev Like KlerosLiquid.extraDataToSubcourtIDAndMinJurors, with a single court (the General Court).
    function _decode(bytes calldata extraData) internal pure returns (uint96 court, uint256 minJurors) {
        // only court 0 exists here; KlerosLiquid also falls back to court 0 for an unknown court
        if (extraData.length >= 64) (, minJurors) = abi.decode(extraData, (uint256, uint256));
        if (minJurors == 0) minJurors = MIN_JURORS;
        court = 0;
    }
}

/// @dev Test stand-in for Kleros's Dispute Resolver (ArbitrableProxy, Ethereum mainnet
/// 0x4b89e798b10478a839ea0abcf86c4b94a3c782a4): the GitHub source ported to 0.8 with the same
/// behaviour and ABI, including the deployed version's array withdrawal functions:
///  - createDispute forwards all msg.value to the arbitrator and emits MetaEvidence and Dispute
///    (metaevidence ID and evidence group = the local ID);
///  - submitEvidence emits Evidence under the local ID, and reverts once the case is ruled;
///  - fundAppeal crowdfunds a ruling: the side matching currentRuling pays appealCost x (1 + winner
///    multiplier) until the end of the appeal period, any other side x (1 + loser multiplier) and only
///    during the first loserAppealPeriodMultiplier part; surplus goes back to msg.sender; once two
///    sides are fully funded the arbitrator's appeal is paid and a new round starts;
///  - rule (arbitrator only): if exactly one side was funded in the last round, that side wins;
///  - withdrawals pay each contributor's refunds and rewards straight to them, once ruled.
/// CappedMath (saturating maths) is reproduced with addCap / subCap / mulCap.
contract MockArbitrableProxy is IArbitrableV1 {
    uint256 public constant MAX_NUMBER_OF_CHOICES = type(uint256).max - 1;

    struct Round {
        mapping(uint256 => uint256) paidFees;
        mapping(uint256 => bool) hasPaid;
        mapping(address => mapping(uint256 => uint256)) contributions;
        uint256 feeRewards;
        uint256[] fundedRulings;
    }

    struct DisputeStruct {
        bytes arbitratorExtraData;
        bool isRuled;
        uint256 ruling;
        uint256 disputeIDOnArbitratorSide;
    }

    address public governor = msg.sender;
    IArbitratorV1 public immutable arbitrator;
    uint256 public winnerStakeMultiplier = 10000;
    uint256 public loserStakeMultiplier = 20000;
    uint256 public loserAppealPeriodMultiplier = 5000;
    uint256 public constant DENOMINATOR = 10000;

    DisputeStruct[] public disputes;
    mapping(uint256 => uint256) public externalIDtoLocalID;
    mapping(uint256 => Round[]) public disputeIDtoRoundArray;
    mapping(uint256 => uint256) public numberOfRulingOptions;

    // ERC-1497 / ERC-792 events
    event MetaEvidence(uint256 indexed _metaEvidenceID, string _evidence);
    event Dispute(address indexed _arbitrator, uint256 indexed _disputeID, uint256 _metaEvidenceID, uint256 _evidenceGroupID);
    event Evidence(address indexed _arbitrator, uint256 indexed _evidenceGroupID, address indexed _party, string _evidence);
    event Ruling(address indexed _arbitrator, uint256 indexed _disputeID, uint256 _ruling);
    // IDisputeResolver events
    event Contribution(uint256 indexed localDisputeID, uint256 indexed round, uint256 ruling, address indexed contributor, uint256 amount);
    event Withdrawal(uint256 indexed localDisputeID, uint256 indexed round, uint256 ruling, address indexed contributor, uint256 reward);
    event RulingFunded(uint256 indexed localDisputeID, uint256 indexed round, uint256 indexed ruling);

    constructor(IArbitratorV1 _arbitrator) {
        arbitrator = _arbitrator;
    }

    function submitEvidence(uint256 _localDisputeID, string calldata _evidenceURI) external {
        DisputeStruct storage dispute = disputes[_localDisputeID];
        require(dispute.isRuled == false, "Cannot submit evidence to a resolved dispute.");
        emit Evidence(address(arbitrator), _localDisputeID, msg.sender, _evidenceURI);
    }

    function createDispute(bytes calldata _arbitratorExtraData, string calldata _metaevidenceURI, uint256 _numberOfRulingOptions)
        external
        payable
        returns (uint256 disputeID)
    {
        require(_numberOfRulingOptions <= MAX_NUMBER_OF_CHOICES, "Number of ruling options out of range.");
        if (_numberOfRulingOptions == 0) _numberOfRulingOptions = MAX_NUMBER_OF_CHOICES;

        disputeID = arbitrator.createDispute{value: msg.value}(_numberOfRulingOptions, _arbitratorExtraData);
        uint256 localDisputeID = disputes.length;
        disputes.push(DisputeStruct({arbitratorExtraData: _arbitratorExtraData, isRuled: false, ruling: 0, disputeIDOnArbitratorSide: disputeID}));
        externalIDtoLocalID[disputeID] = localDisputeID;
        numberOfRulingOptions[localDisputeID] = _numberOfRulingOptions;
        disputeIDtoRoundArray[localDisputeID].push();

        emit MetaEvidence(localDisputeID, _metaevidenceURI);
        emit Dispute(address(arbitrator), disputeID, localDisputeID, localDisputeID);
    }

    function fundAppeal(uint256 _localDisputeID, uint256 _ruling) external payable returns (bool fullyFunded) {
        require(_ruling <= numberOfRulingOptions[_localDisputeID], "There is no such ruling to fund.");
        DisputeStruct storage dispute = disputes[_localDisputeID];
        uint256 disputeID = dispute.disputeIDOnArbitratorSide;

        uint256 originalCost;
        uint256 totalCost;
        {
            uint256 currentRuling = arbitrator.currentRuling(disputeID);
            (originalCost, totalCost) = appealCost(disputeID, dispute.arbitratorExtraData, _ruling, currentRuling);
            checkAppealPeriod(disputeID, _ruling, currentRuling);
        }

        Round[] storage rounds = disputeIDtoRoundArray[_localDisputeID];
        uint256 lastRoundIndex = rounds.length - 1;
        Round storage lastRound = rounds[lastRoundIndex];

        require(!lastRound.hasPaid[_ruling], "Appeal fee has already been paid.");
        uint256 paidFeesInLastRound = lastRound.paidFees[_ruling];

        uint256 contribution = subCap(totalCost, paidFeesInLastRound) > msg.value ? msg.value : subCap(totalCost, paidFeesInLastRound);
        lastRound.paidFees[_ruling] += contribution;

        emit Contribution(_localDisputeID, lastRoundIndex, _ruling, msg.sender, contribution);
        lastRound.contributions[msg.sender][_ruling] += contribution;

        paidFeesInLastRound = lastRound.paidFees[_ruling];

        if (paidFeesInLastRound >= totalCost) {
            lastRound.feeRewards += paidFeesInLastRound;
            lastRound.fundedRulings.push(_ruling);
            lastRound.hasPaid[_ruling] = true;
            emit RulingFunded(_localDisputeID, lastRoundIndex, _ruling);
        }

        if (lastRound.fundedRulings.length == 2) {
            rounds.push();
            lastRound.feeRewards = subCap(lastRound.feeRewards, originalCost);
            arbitrator.appeal{value: originalCost}(disputeID, dispute.arbitratorExtraData);
        }

        bool sent = payable(msg.sender).send(subCap(msg.value, contribution)); // failure ignored, like the original
        sent;
        return lastRound.hasPaid[_ruling];
    }

    /// @dev Deployed version: every round, for each ruling in `_contributedTo`.
    function withdrawFeesAndRewardsForAllRounds(uint256 _localDisputeID, address payable _contributor, uint256[] calldata _contributedTo)
        external
    {
        uint256 numberOfRounds = disputeIDtoRoundArray[_localDisputeID].length;
        for (uint256 roundNumber = 0; roundNumber < numberOfRounds; roundNumber++) {
            for (uint256 i = 0; i < _contributedTo.length; i++) {
                withdrawFeesAndRewards(_localDisputeID, _contributor, roundNumber, _contributedTo[i]);
            }
        }
    }

    /// @dev Deployed version: one round, for each ruling in `_contributedTo`.
    function withdrawFeesAndRewardsForMultipleRulings(
        uint256 _localDisputeID,
        address payable _contributor,
        uint256 _roundNumber,
        uint256[] calldata _contributedTo
    ) external {
        for (uint256 i = 0; i < _contributedTo.length; i++) {
            withdrawFeesAndRewards(_localDisputeID, _contributor, _roundNumber, _contributedTo[i]);
        }
    }

    function withdrawFeesAndRewards(uint256 _localDisputeID, address payable _contributor, uint256 _roundNumber, uint256 _ruling)
        public
        returns (uint256 amount)
    {
        DisputeStruct storage dispute = disputes[_localDisputeID];
        require(dispute.isRuled, "The dispute should be solved");
        Round storage round = disputeIDtoRoundArray[_localDisputeID][_roundNumber];
        amount = getWithdrawableAmount(round, _contributor, _ruling, dispute.ruling);
        if (amount != 0) {
            round.contributions[_contributor][_ruling] = 0;
            bool sent = _contributor.send(amount); // failure ignored, like the original
            sent;
            emit Withdrawal(_localDisputeID, _roundNumber, _ruling, _contributor, amount);
        }
    }

    function rule(uint256 _externalDisputeID, uint256 _ruling) external {
        uint256 localDisputeID = externalIDtoLocalID[_externalDisputeID];
        DisputeStruct storage dispute = disputes[localDisputeID];
        require(msg.sender == address(arbitrator), "Only the arbitrator can execute this.");
        require(_ruling <= numberOfRulingOptions[localDisputeID], "Invalid ruling.");
        require(dispute.isRuled == false, "This dispute has been ruled already.");

        dispute.isRuled = true;
        dispute.ruling = _ruling;

        Round[] storage rounds = disputeIDtoRoundArray[localDisputeID];
        Round storage lastRound = disputeIDtoRoundArray[localDisputeID][rounds.length - 1];
        // only one ruling option funded: it wins by default
        if (lastRound.fundedRulings.length == 1) {
            dispute.ruling = lastRound.fundedRulings[0];
        }
        emit Ruling(msg.sender, _externalDisputeID, dispute.ruling);
    }

    function setGovernor(address _newGovernor) external {
        require(msg.sender == governor, "Only the governor can execute this.");
        governor = _newGovernor;
    }

    function changeMultipliers(uint256 _winnerStakeMultiplier, uint256 _loserStakeMultiplier, uint256 _loserAppealPeriodMultiplier)
        external
    {
        require(msg.sender == governor, "Only the governor can execute this.");
        winnerStakeMultiplier = _winnerStakeMultiplier;
        loserStakeMultiplier = _loserStakeMultiplier;
        loserAppealPeriodMultiplier = _loserAppealPeriodMultiplier;
    }

    /// @dev Deployed version: summed over every round, for each ruling in `_contributedTo`.
    function getTotalWithdrawableAmount(uint256 _localDisputeID, address _contributor, uint256[] calldata _contributedTo)
        external
        view
        returns (uint256 sum)
    {
        DisputeStruct storage dispute = disputes[_localDisputeID];
        if (!dispute.isRuled) return 0;
        uint256 finalRuling = dispute.ruling;
        uint256 numberOfRounds = disputeIDtoRoundArray[_localDisputeID].length;
        for (uint256 roundNumber = 0; roundNumber < numberOfRounds; roundNumber++) {
            Round storage round = disputeIDtoRoundArray[_localDisputeID][roundNumber];
            for (uint256 i = 0; i < _contributedTo.length; i++) {
                sum += getWithdrawableAmount(round, _contributor, _contributedTo[i], finalRuling);
            }
        }
    }

    function getMultipliers()
        external
        view
        returns (uint256 _winnerStakeMultiplier, uint256 _loserStakeMultiplier, uint256 _loserAppealPeriodMultiplier, uint256 _denominator)
    {
        return (winnerStakeMultiplier, loserStakeMultiplier, loserAppealPeriodMultiplier, DENOMINATOR);
    }

    function getWithdrawableAmount(Round storage _round, address _contributor, uint256 _ruling, uint256 _finalRuling)
        internal
        view
        returns (uint256 amount)
    {
        if (!_round.hasPaid[_ruling]) {
            // reimbursed if funding was unsuccessful for this ruling option
            amount = _round.contributions[_contributor][_ruling];
        } else {
            if (_ruling == _finalRuling) {
                amount = _round.paidFees[_ruling] > 0
                    ? (_round.contributions[_contributor][_ruling] * _round.feeRewards) / _round.paidFees[_ruling]
                    : 0;
            } else if (!_round.hasPaid[_finalRuling]) {
                // the final winner was not funded in this round: the funded options share the rewards
                amount = (_round.contributions[_contributor][_ruling] * _round.feeRewards)
                    / (_round.paidFees[_round.fundedRulings[0]] + _round.paidFees[_round.fundedRulings[1]]);
            }
        }
    }

    function checkAppealPeriod(uint256 _disputeID, uint256 _ruling, uint256 _currentRuling) internal view {
        (uint256 originalStart, uint256 originalEnd) = arbitrator.appealPeriod(_disputeID);
        if (_currentRuling == _ruling) {
            require(block.timestamp < originalEnd, "Funding must be made within the appeal period.");
        } else {
            require(
                block.timestamp < (originalStart + ((originalEnd - originalStart) * loserAppealPeriodMultiplier) / DENOMINATOR),
                "Funding must be made within the appeal period."
            );
        }
    }

    function appealCost(uint256 _disputeID, bytes memory _arbitratorExtraData, uint256 _ruling, uint256 _currentRuling)
        internal
        view
        returns (uint256 originalCost, uint256 specificCost)
    {
        uint256 multiplier = _ruling == _currentRuling ? winnerStakeMultiplier : loserStakeMultiplier;
        uint256 appealFee = arbitrator.appealCost(_disputeID, _arbitratorExtraData);
        return (appealFee, addCap(appealFee, mulCap(appealFee, multiplier) / DENOMINATOR));
    }

    // CappedMath
    function addCap(uint256 a, uint256 b) internal pure returns (uint256) {
        unchecked {
            uint256 c = a + b;
            return c >= a ? c : type(uint256).max;
        }
    }

    function subCap(uint256 a, uint256 b) internal pure returns (uint256) {
        return b > a ? 0 : a - b;
    }

    function mulCap(uint256 a, uint256 b) internal pure returns (uint256) {
        if (a == 0) return 0;
        unchecked {
            uint256 c = a * b;
            return c / a == b ? c : type(uint256).max;
        }
    }
}
