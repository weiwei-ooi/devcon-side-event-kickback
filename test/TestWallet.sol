// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @dev A wallet contract for tests. It acts as a guest through `exec` (deposit, challenge, claim...)
/// and decides what happens when ETH arrives: accept it, refuse it, burn all the gas it is given,
/// use about 66,000 gas like a heavy smart wallet, or call back into a contract (reentrancy). A
/// reentry attempt is recorded (`reentryOk`, `reentryError`) and never makes the payment fail.
contract TestWallet {
    enum Mode {
        Accept,
        Refuse,
        BurnGas,
        Busy,
        Reenter
    }

    Mode public mode;
    address public reenterTarget;
    bool public reentered;
    bool public reentryOk;
    bytes public reenterData;
    uint256 public reenterValue;
    bytes public reentryError;
    uint256 public received; // number of payments received
    mapping(uint256 => uint256) private _scratch;

    function setMode(Mode m) external {
        mode = m;
    }

    /// @dev On the next payment, call `target` with `data` (and `value` wei of what the wallet holds).
    function setReentry(address target, bytes calldata data, uint256 value) external {
        mode = Mode.Reenter;
        reenterTarget = target;
        reenterData = data;
        reenterValue = value;
        reentered = false;
    }

    function exec(address target, bytes calldata data) external payable returns (bytes memory ret) {
        bool ok;
        (ok, ret) = target.call{value: msg.value}(data);
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
    }

    receive() external payable {
        Mode m = mode;
        if (m == Mode.Refuse) revert("TestWallet: no ETH please");
        if (m == Mode.BurnGas) {
            // spin until the gas runs out
            for (uint256 i = 1; i != 0; ++i) _scratch[0] = i;
        }
        if (m == Mode.Busy) {
            // two fresh storage slots and a counter: ~66k gas, far more than `transfer`'s 2,300
            _scratch[received * 2 + 1] = 1;
            _scratch[received * 2 + 2] = 1;
        }
        if (m == Mode.Reenter && !reentered) {
            reentered = true;
            (reentryOk, reentryError) = reenterTarget.call{value: reenterValue}(reenterData);
        }
        received += 1;
    }
}
