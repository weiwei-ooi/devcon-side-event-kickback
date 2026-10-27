// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @dev A minimal ERC-20 for tests: USDC (6 decimals) sent to the deposit contract by mistake.
/// `style` sets how `transfer` answers: 0 returns true (like USDC), 1 returns nothing (like USDT),
/// 2 returns false without moving anything (a token that reports failure instead of reverting).
contract TestToken {
    string public constant symbol = "USDC";
    uint8 public constant decimals = 6;
    uint8 public style;
    mapping(address => uint256) public balanceOf;

    event Transfer(address indexed from, address indexed to, uint256 value);

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function setStyle(uint8 s) external {
        style = s;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        if (style == 2) return false;
        require(balanceOf[msg.sender] >= amount, "TestToken: not enough tokens");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        if (style == 1) {
            assembly ("memory-safe") {
                return(0, 0)
            }
        }
        return true;
    }
}
