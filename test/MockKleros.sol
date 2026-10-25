// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @dev Test stand-in for KlerosCore: a fixed arbitration cost.
contract MockArbitrator {
    uint256 public cost = 0.015 ether;

    function setCost(uint256 c) external {
        cost = c;
    }

    function arbitrationCost(bytes calldata) external view returns (uint256) {
        return cost;
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
    }

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
