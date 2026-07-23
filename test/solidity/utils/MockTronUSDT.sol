// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

/// @notice Reproduces Tron's canonical USDT behaviour:
///         - transfer() declares `returns (bool)` but never assigns the return value, so the ABI
///           decoder sees 32 zero bytes (decoded as `false`). SafeTransferLib reverts on this.
///         - transferFrom() does NOT declare a return type at all, so it returns 0 bytes.
///           SafeTransferLib accepts 0-byte returns as success — no bypass needed for transferFrom.
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

    // Declares returns (bool) but never assigns the return variable — mirrors the original Tron USDT
    // bytecode (~0.4.x) which returns 32 zero bytes instead of `true`.
    // SafeTransferLib decodes those zero bytes as `false` and reverts, which is the behaviour
    // the Tron USDT bypass in LibAsset is designed to work around.
    function transfer(address to, uint256 amount) external returns (bool) {
        if (balanceOf[msg.sender] < amount) revert InsufficientBalance();
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
    }

    // No return type declared — mirrors real Tron USDT's transferFrom which returns 0 bytes.
    function transferFrom(address from, address to, uint256 amount) external {
        if (allowance[from][msg.sender] < amount)
            revert InsufficientAllowance();
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
