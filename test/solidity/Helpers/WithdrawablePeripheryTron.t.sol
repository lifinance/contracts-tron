// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { ZeroAmount, ETHTransferFailed } from "lifi/Errors/GenericErrors.sol";
import { WithdrawablePeriphery } from "lifi/Helpers/WithdrawablePeriphery.sol";
import { TestBaseLocal } from "test/solidity/utils/TestBaseLocal.sol";
import { NonETHReceiver } from "test/solidity/utils/TestHelpers.sol";
import { TestContract } from "./WithdrawablePeriphery.t.sol";

contract WithdrawablePeripheryTronTest is TestBaseLocal {
    WithdrawablePeriphery internal withdrawable;

    function setUp() public {
        initTestBaseLocal();

        withdrawable = new TestContract(USER_DIAMOND_OWNER);

        deal(ADDRESS_USDC, address(withdrawable), 100 * 10 ** usdc.decimals());
        deal(address(withdrawable), 1 ether);

        vm.label(address(withdrawable), "WithdrawablePeriphery");
    }

    function testRevert_ZeroAmount() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        vm.expectRevert(ZeroAmount.selector);

        withdrawable.withdrawToken(ADDRESS_USDC, payable(USER_RECEIVER), 0);
    }

    function testRevert_NativeTransferFailed() public {
        address payable receiver = payable(address(new NonETHReceiver()));

        vm.startPrank(USER_DIAMOND_OWNER);

        vm.expectRevert(ETHTransferFailed.selector);

        withdrawable.withdrawToken(address(0), receiver, 0.1 ether);
    }
}
