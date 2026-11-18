// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @dev A minimal ERC-20 for tests. `style`: 0 returns true (USDC), 1 returns nothing (USDT), 2 returns false
/// without moving anything, 3 takes a 1% fee on transfers (refused by events), 4 blocks transfers to `blocked`.
contract TestToken {
    string public symbol;
    uint8 public decimals;
    uint8 public style;
    address public blocked;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory symbol_, uint8 decimals_) {
        symbol = symbol_;
        decimals = decimals_;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function setStyle(uint8 s) external {
        style = s;
    }

    function setBlocked(address a) external {
        blocked = a;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        return _move(msg.sender, to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(allowance[from][msg.sender] >= amount, "TestToken: allowance");
        allowance[from][msg.sender] -= amount;
        return _move(from, to, amount);
    }

    function _move(address from, address to, uint256 amount) internal returns (bool) {
        if (style == 2) return false;
        require(!(style == 4 && to == blocked), "TestToken: blocked");
        require(balanceOf[from] >= amount, "TestToken: balance");
        balanceOf[from] -= amount;
        uint256 got = style == 3 ? amount - amount / 100 : amount;
        balanceOf[to] += got;
        emit Transfer(from, to, got);
        if (style == 1) {
            assembly ("memory-safe") {
                return(0, 0)
            }
        }
        return true;
    }
}
