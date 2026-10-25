// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @dev Test-only 6-decimal token that emits standard Transfer events.
/// Like real USDC it can blocklist addresses (transfers to them fail).
contract MockUSDC {
    string public constant name = "Mock USDC";
    string public constant symbol = "USDC";
    uint8 public constant decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => bool) public blocked;
    // 0 = like USDC (revert when blocked), 1 = return false when blocked, 2 = return no data at all
    uint8 public mode;

    event Transfer(address indexed from, address indexed to, uint256 value);

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function setBlocked(address a, bool b) external {
        blocked[a] = b;
    }

    function setMode(uint8 m) external {
        mode = m;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        if (mode == 1 && (blocked[to] || blocked[msg.sender])) return false;
        require(!blocked[to] && !blocked[msg.sender], "blocked");
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        if (mode == 2) {
            assembly {
                return(0, 0)
            }
        }
        return true;
    }
}
