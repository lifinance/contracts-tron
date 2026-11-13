// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { SafeTransferLib } from "solady/utils/SafeTransferLib.sol";
import { TestBaseLocal } from "../utils/TestBaseLocal.sol";
import { LibAsset } from "lifi/Libraries/LibAsset.sol";
import { MockTronUSDT } from "../utils/MockTronUSDT.sol";

contract LibAssetTronImplementer {
    function transferERC20(
        address assetId,
        address recipient,
        uint256 amount
    ) public {
        LibAsset.transferERC20(assetId, recipient, amount);
    }
}

contract LibAssetTronTest is TestBaseLocal {
    // Duplicated from LibAsset, whose constants are internal.
    address internal constant TRON_USDT_ADDR =
        0xa614f803B6FD780986A42c78Ec9c7f77e6DeD13C;
    uint256 internal constant TRON_CHAIN_ID = 728126428;

    LibAssetTronImplementer internal implementer;

    function setUp() public {
        implementer = new LibAssetTronImplementer();
        initTestBaseLocal();

        vm.etch(TRON_USDT_ADDR, address(new MockTronUSDT()).code);
        MockTronUSDT(TRON_USDT_ADDR).mint(address(implementer), 1000);

        vm.label(TRON_USDT_ADDR, "TRON_USDT");
        vm.label(address(implementer), "LibAssetTronImplementer");
    }

    function test_SucceedsWhenSendingTronUsdtOnTronChain() public {
        vm.chainId(TRON_CHAIN_ID);

        implementer.transferERC20(TRON_USDT_ADDR, USER_RECEIVER, 1000);

        assertEq(MockTronUSDT(TRON_USDT_ADDR).balanceOf(USER_RECEIVER), 1000);
    }

    function testRevert_TronUsdtTransferRevertsOnNonTronChain() public {
        vm.expectRevert(SafeTransferLib.TransferFailed.selector);

        implementer.transferERC20(TRON_USDT_ADDR, USER_RECEIVER, 1000);
    }
}
