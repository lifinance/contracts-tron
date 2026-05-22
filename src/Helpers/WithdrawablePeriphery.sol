// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { TransferrableOwnership } from "./TransferrableOwnership.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { ZeroAmount } from "../Errors/GenericErrors.sol";

/// @custom:version 1.0.0-tron
abstract contract WithdrawablePeriphery is TransferrableOwnership {
    event TokensWithdrawn(
        address assetId,
        address payable receiver,
        uint256 amount
    );

    constructor(address _owner) TransferrableOwnership(_owner) {}

    function withdrawToken(
        address assetId,
        address payable receiver,
        uint256 amount
    ) external onlyOwner {
        if (amount == 0) revert ZeroAmount();

        LibAsset.transferAsset(assetId, receiver, amount);

        emit TokensWithdrawn(assetId, receiver, amount);
    }
}
