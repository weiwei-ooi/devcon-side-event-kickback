// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @dev Test stand-in for KlerosCore: a fixed arbitration cost, plus the views and calls the console and
/// guest page use for appeals (period, current ruling, appeal period and cost, dispute kit, executeRuling).
contract MockArbitrator {
    uint256 public cost = 0.015 ether;
    MockDisputeResolver public resolver;
    MockDisputeKit public kit;

    struct Core {
        uint8 period; // 0 evidence, 1 commit, 2 vote, 3 appeal, 4 execution (like KlerosCore.Period)
        bool ruled;
        uint256 lastPeriodChange;
        uint256 ruling; // current ruling of the latest round
        uint256 appealStart;
        uint256 appealEnd;
        uint256 rounds;
    }

    mapping(uint256 => Core) internal core;

    constructor() {
        kit = new MockDisputeKit(this);
    }

    function setCost(uint256 c) external {
        cost = c;
    }

    function setResolver(MockDisputeResolver r) external {
        resolver = r;
    }

    function arbitrationCost(bytes calldata) external view returns (uint256) {
        return cost;
    }

    /// @dev Called by the mock resolver when a dispute is created.
    function opened(uint256 id) external {
        core[id].rounds = 1;
        core[id].lastPeriodChange = block.timestamp;
    }

    /// @dev Test hook: jurors voted `ruling`; the appeal period runs for `duration` seconds from now.
    function startAppealPeriod(uint256 id, uint256 ruling, uint256 duration) external {
        Core storage d = core[id];
        d.period = 3;
        d.ruling = ruling;
        d.lastPeriodChange = block.timestamp;
        d.appealStart = block.timestamp;
        d.appealEnd = block.timestamp + duration;
    }

    /// @dev Called by the mock dispute kit when both sides are funded: a new round starts.
    function appeal(uint256 id) external payable {
        require(msg.sender == address(kit), "kit only");
        Core storage d = core[id];
        d.period = 0;
        d.rounds += 1;
        d.lastPeriodChange = block.timestamp;
        d.appealStart = 0;
        d.appealEnd = 0;
    }

    function passPeriod(uint256 id) external {
        Core storage d = core[id];
        require(d.period == 3 && block.timestamp >= d.appealEnd, "not yet");
        d.period = 4;
        d.lastPeriodChange = block.timestamp;
        d.appealStart = 0;
        d.appealEnd = 0;
    }

    function executeRuling(uint256 id) external {
        Core storage d = core[id];
        require(d.period == 4 && !d.ruled, "not executable");
        d.ruled = true;
        (uint256 ruling,,) = currentRuling(id);
        resolver.giveRuling(resolver.arbitratorDisputeIDToLocalID(id), ruling);
    }

    function disputes(uint256 id)
        external
        view
        returns (uint96 courtID, address arbitrated, uint8 period, bool ruled, uint256 lastPeriodChange)
    {
        Core storage d = core[id];
        return (1, address(resolver), d.period, d.ruled, d.lastPeriodChange);
    }

    /// @dev Like DisputeKitClassic.currentRuling: once the appeal period is over (execution), if only
    /// one side funded an appeal in the last round, that side wins whatever the jurors voted.
    function currentRuling(uint256 id) public view returns (uint256 ruling, bool tied, bool overridden) {
        Core storage d = core[id];
        if (d.period == 4) {
            uint256[] memory f = kit.getFundedChoices(id);
            if (f.length == 1) return (f[0], false, true);
        }
        return (d.ruling, d.ruling == 0, false);
    }

    function appealPeriod(uint256 id) external view returns (uint256 start, uint256 end) {
        return (core[id].appealStart, core[id].appealEnd);
    }

    /// @dev Like KlerosCore: the next round has 2n+1 jurors (3 → 7 → 15 …).
    function appealCost(uint256 id) public view returns (uint256) {
        uint256 jurors = 3;
        for (uint256 i = 1; i < core[id].rounds; ++i) jurors = jurors * 2 + 1;
        return (cost / 3) * (jurors * 2 + 1);
    }

    function getNumberOfRounds(uint256 id) external view returns (uint256) {
        return core[id].rounds;
    }

    function disputeKits(uint256) external view returns (address) {
        return address(kit);
    }
}

/// @dev Test stand-in for Kleros's DisputeKitClassic appeal crowdfunding, with the same rules and
/// reward maths: the side that lost the round pays the appeal cost + 2x and only during the first
/// half of the appeal period; the side that won pays + 1x; when both sides are fully funded a new
/// round starts. After the final ruling, funders of the winning side share the round's fee rewards,
/// sides never fully funded are reimbursed. `newStyle` switches to the newer 3-argument withdrawal.
contract MockDisputeKit {
    uint256 public constant WINNER_STAKE_MULTIPLIER = 10000;
    uint256 public constant LOSER_STAKE_MULTIPLIER = 20000;
    uint256 public constant LOSER_APPEAL_PERIOD_MULTIPLIER = 5000;

    MockArbitrator public immutable core;
    bool public newStyle;
    mapping(uint256 => mapping(uint256 => mapping(uint256 => uint256))) public paidFees; // id => round => choice
    mapping(uint256 => mapping(uint256 => mapping(uint256 => bool))) public hasPaid;
    mapping(uint256 => mapping(uint256 => uint256)) public feeRewards;
    mapping(uint256 => mapping(uint256 => mapping(address => mapping(uint256 => uint256)))) public contributions;
    mapping(uint256 => mapping(uint256 => uint256[])) internal funded;

    event Contribution(uint256 indexed _coreDisputeID, uint256 indexed _coreRoundID, uint256 _choice, address indexed _contributor, uint256 _amount);
    event ChoiceFunded(uint256 indexed _coreDisputeID, uint256 indexed _coreRoundID, uint256 indexed _choice);
    event Withdrawal(uint256 indexed _coreDisputeID, uint256 indexed _coreRoundID, uint256 _choice, address indexed _contributor, uint256 _amount);

    constructor(MockArbitrator c) {
        core = c;
    }

    function setNewStyle(bool v) external {
        newStyle = v;
    }

    function fundAppeal(uint256 id, uint256 choice) external payable {
        require(choice == 1 || choice == 2, "choice");
        (uint256 start, uint256 end) = core.appealPeriod(id);
        require(block.timestamp >= start && block.timestamp < end, "NotAppealPeriod");
        (uint256 ruling,,) = core.currentRuling(id);
        uint256 multiplier = WINNER_STAKE_MULTIPLIER;
        if (ruling != choice) {
            require(block.timestamp - start < ((end - start) * LOSER_APPEAL_PERIOD_MULTIPLIER) / 10000, "NotAppealPeriodForLoser");
            multiplier = LOSER_STAKE_MULTIPLIER;
        }
        uint256 round = core.getNumberOfRounds(id) - 1;
        require(!hasPaid[id][round][choice], "AppealFeeIsAlreadyPaid");
        uint256 appealCost = core.appealCost(id);
        uint256 total = appealCost + (appealCost * multiplier) / 10000;
        uint256 paid = paidFees[id][round][choice];
        uint256 contribution = msg.value < total - paid ? msg.value : total - paid;
        paidFees[id][round][choice] = paid + contribution;
        contributions[id][round][msg.sender][choice] += contribution;
        emit Contribution(id, round, choice, msg.sender, contribution);
        if (paid + contribution >= total) {
            feeRewards[id][round] += total;
            hasPaid[id][round][choice] = true;
            funded[id][round].push(choice);
            emit ChoiceFunded(id, round, choice);
            if (funded[id][round].length > 1) {
                feeRewards[id][round] -= appealCost;
                core.appeal{value: appealCost}(id);
            }
        }
        if (msg.value > contribution) payable(msg.sender).transfer(msg.value - contribution);
    }

    function getFundedChoices(uint256 id) external view returns (uint256[] memory) {
        return funded[id][core.getNumberOfRounds(id) - 1];
    }

    /// @dev The version deployed on Arbitrum One: one round at a time.
    function withdrawFeesAndRewards(uint256 id, address payable beneficiary, uint256 round, uint256 choice)
        external
        returns (uint256 amount)
    {
        require(!newStyle, "unknown function");
        amount = _owed(id, beneficiary, round, choice);
        _pay(id, round, choice, beneficiary, amount);
    }

    /// @dev The newer version: every round at once.
    function withdrawFeesAndRewards(uint256 id, address payable beneficiary, uint256 choice) external returns (uint256 amount) {
        require(newStyle, "unknown function");
        uint256 rounds = core.getNumberOfRounds(id);
        for (uint256 r; r < rounds; ++r) amount += _owed(id, beneficiary, r, choice);
        _pay(id, 0, choice, beneficiary, amount);
    }

    function _owed(uint256 id, address beneficiary, uint256 round, uint256 choice) internal returns (uint256 amount) {
        (,, uint8 period,,) = core.disputes(id);
        require(period == 4, "DisputeNotResolved");
        (uint256 finalRuling,,) = core.currentRuling(id);
        uint256 mine = contributions[id][round][beneficiary][choice];
        if (!hasPaid[id][round][choice]) {
            amount = mine; // never fully funded: reimbursed
        } else if (choice == finalRuling) {
            amount = (mine * feeRewards[id][round]) / paidFees[id][round][choice];
        } else if (!hasPaid[id][round][finalRuling]) {
            uint256[] storage f = funded[id][round];
            uint256 both = paidFees[id][round][f[0]] + (f.length > 1 ? paidFees[id][round][f[1]] : 0);
            amount = (mine * feeRewards[id][round]) / both;
        }
        contributions[id][round][beneficiary][choice] = 0;
    }

    function _pay(uint256 id, uint256 round, uint256 choice, address payable to, uint256 amount) internal {
        if (amount == 0) return;
        emit Withdrawal(id, round, choice, to, amount);
        to.transfer(amount);
    }

    receive() external payable {}
}

/// @dev Test stand-in for the Kleros v2 EvidenceModule.
contract MockEvidenceModule {
    event Evidence(uint256 indexed _externalDisputeID, address indexed _party, string _evidence);

    function submitEvidence(uint256 id, string calldata evidence) external {
        emit Evidence(id, msg.sender, evidence);
    }
}

/// @dev Test stand-in for the Kleros DisputeResolver, with a hook to give rulings.
contract MockDisputeResolver {
    struct D {
        bytes extraData;
        bool isRuled;
        uint256 ruling;
        uint256 options;
    }

    MockArbitrator public arbitrator;
    D[] public disputes;
    mapping(uint256 => uint256) public arbitratorDisputeIDToLocalID;
    string public lastTemplate;
    uint256 public received;

    constructor(MockArbitrator a) {
        arbitrator = a;
    }

    function createDisputeForTemplate(bytes calldata extraData, string calldata template, string calldata, uint256 options)
        external
        payable
        returns (uint256 id)
    {
        require(msg.value >= arbitrator.cost(), "fee");
        received += msg.value;
        uint256 local = disputes.length;
        disputes.push(D(extraData, false, 0, options));
        id = 1000 + local; // arbitrator-side ids differ from local ids, like the real thing
        arbitratorDisputeIDToLocalID[id] = local;
        lastTemplate = template;
        if (address(arbitrator.resolver()) == address(this)) arbitrator.opened(id);
    }

    /// @dev Test hook (and what MockArbitrator.executeRuling calls): the final ruling arrives.
    function giveRuling(uint256 local, uint256 ruling) external {
        disputes[local].isRuled = true;
        disputes[local].ruling = ruling;
    }
}

/// @dev A wallet that refuses ETH, to test the withdrawEth fallback.
contract EthRefuser {
    function challenge(address kickback) external payable {
        (bool ok, bytes memory err) = kickback.call{value: msg.value}(abi.encodeWithSignature("challenge()"));
        if (!ok) assembly { revert(add(err, 32), mload(err)) }
    }

    function withdrawTo(address kickback, address to) external {
        (bool ok, bytes memory err) = kickback.call(abi.encodeWithSignature("withdrawEth(address)", to));
        if (!ok) assembly { revert(add(err, 32), mload(err)) }
    }
}
