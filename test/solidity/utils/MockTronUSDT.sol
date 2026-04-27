// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

/// @notice Reproduces Tron's canonical USDT behaviour: transfer() and transferFrom() update
///         state correctly but never execute `return true`, so the ABI decoder sees 32 zero
///         bytes instead of `true`.  SafeTransferLib treats this as a failure and reverts.
contract MockTronUSDT {
    string public name = "Tron USD Tether";
    string public symbol = "USDT";
    uint8 public decimals = 6;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    error InsufficientBalance();
    error InsufficientAllowance();

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    // Intentionally omits `return true` — mirrors the original Tron USDT bytecode.
    function transfer(address to, uint256 amount) external {
        if (balanceOf[msg.sender] < amount) revert InsufficientBalance();
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
    }

    function transferFrom(
        address from,
        address to,
        uint256 amount
    ) external {
        if (allowance[from][msg.sender] < amount) revert InsufficientAllowance();
        if (balanceOf[from] < amount) revert InsufficientBalance();
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }
}
