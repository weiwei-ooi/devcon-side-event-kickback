// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @dev A wallet contract for tests. It acts as a guest through `exec` (deposit, challenge, claim...)
/// and decides what happens when ETH arrives: accept it, refuse it, burn all the gas it is given,
/// use about 28,000 gas like a heavy smart wallet (more than a Safe needs), or call back into a
/// contract (reentrancy). A reentry attempt is recorded (`reentryOk`, `reentryError`) and never makes
/// the payment fail. Every mode except BurnGas fits in the contract's PAYOUT_GAS (40,000).
contract TestWallet {
    enum Mode {
        Accept,
        Refuse,
        BurnGas,
        Busy,
        Reenter
    }

    // One storage slot holds the mode, the reentry flags, the payment counter and the reentry target.
    // It is non-zero from deployment on (`_ready`), so recording a payment costs about 5,000 gas, like a
    // real wallet's bookkeeping; only Busy mode pays for a fresh storage slot (about 22,000 gas).
    Mode public mode;
    bool private _ready = true;
    bool public reentered;
    bool public reentryOk;
    uint64 public received; // number of payments received
    address public reenterTarget;
    bytes public reenterData;
    uint256 public reenterValue;
    bytes public reentryError;
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
        reentryError = hex"00"; // a placeholder: recording the outcome then overwrites a slot already in use
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
            // one fresh storage slot and the counter: ~28k gas, far more than `transfer`'s 2,300
            _scratch[received + 1] = 1;
        }
        if (m == Mode.Reenter && !reentered) {
            reentered = true;
            (reentryOk, reentryError) = reenterTarget.call{value: reenterValue}(reenterData);
        }
        received += 1;
    }
}

/// @dev Deploys wallets that use up all the gas they are given when ETH arrives, like a hostile contract
/// wallet or an EIP-7702 delegated account that loops in its receive. Their code is the single INVALID
/// opcode, which consumes all the gas of the call at once (the same cost as a loop, much faster to run
/// on a test chain). `make(n)` creates n of them in one transaction (their addresses come back), to
/// check that the worst payout batch still fits in one Ethereum transaction.
contract GasBurners {
    function make(uint256 n) external returns (address[] memory ws) {
        ws = new address[](n);
        // init code that returns the 1-byte runtime 0xfe (INVALID): PUSH1 0xfe PUSH1 0 MSTORE8 PUSH1 1 PUSH1 0 RETURN
        bytes memory init = hex"60fe60005360016000f3";
        for (uint256 i; i < n; ++i) {
            address w;
            assembly ("memory-safe") {
                w := create(0, add(init, 32), mload(init))
            }
            require(w != address(0), "GasBurners: create failed");
            ws[i] = w;
        }
    }
}
