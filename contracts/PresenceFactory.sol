// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PresenceEvent} from "./PresenceEvent.sol";

/// @title PresenceFactory: Proof of Presence
/// @notice Anyone creates an event here, with their own deposit (ETH or an ERC-20 token), dates and capacity. Each
/// event is an EIP-1167 minimal clone of one fixed implementation, so every event runs exactly the same code, with
/// the Kleros challenge layer always on (the Dispute Resolver, court, jurors and juror policy are fixed in that
/// implementation). The factory has no owner and nothing can be upgraded. To use other settings (another chain,
/// another court), deploy your own implementation and factory.
contract PresenceFactory {
    error NotAnImplementation();

    /// @notice The event code every clone runs.
    address public immutable implementation;

    mapping(address => bool) public isEvent;
    address[] private _events;
    mapping(address => address[]) private _byOrganiser;

    event EventCreated(address indexed eventContract, address indexed organiser, address indexed token, uint256 depositAmount, string name);

    constructor(address implementation_) {
        require(implementation_.code.length > 0, NotAnImplementation());
        // a real implementation answers this and is locked (its factory is address(1))
        require(PresenceEvent(payable(implementation_)).factory() == address(1), NotAnImplementation());
        implementation = implementation_;
    }

    /// @notice Create an event. The caller becomes its organiser (owner).
    function createEvent(PresenceEvent.Config calldata config) external returns (address ev) {
        bytes20 impl = bytes20(implementation);
        assembly ("memory-safe") {
            let ptr := mload(0x40)
            mstore(ptr, 0x3d602d80600a3d3981f3363d3d373d3d3d363d73000000000000000000000000)
            mstore(add(ptr, 0x14), impl)
            mstore(add(ptr, 0x28), 0x5af43d82803e903d91602b57fd5bf30000000000000000000000000000000000)
            ev := create(0, ptr, 0x37)
        }
        require(ev != address(0), NotAnImplementation());
        PresenceEvent(payable(ev)).initialize(msg.sender, config);
        isEvent[ev] = true;
        _events.push(ev);
        _byOrganiser[msg.sender].push(ev);
        emit EventCreated(ev, msg.sender, config.token, config.depositAmount, config.name);
    }

    function eventCount() external view returns (uint256) {
        return _events.length;
    }

    /// @notice Events in creation order, `limit` from `offset`.
    function events(uint256 offset, uint256 limit) external view returns (address[] memory out) {
        uint256 n = _events.length;
        if (offset >= n) return out;
        uint256 end = offset + limit > n ? n : offset + limit;
        out = new address[](end - offset);
        for (uint256 i = offset; i < end; ++i) out[i - offset] = _events[i];
    }

    /// @notice Events created by `organiser` (ownership may have moved since: check each event's `owner`).
    function eventsOf(address organiser) external view returns (address[] memory) {
        return _byOrganiser[organiser];
    }
}
