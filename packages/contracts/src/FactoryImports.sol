// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

// Compile the audited ERC-4337 v0.7 SimpleAccount artifacts inside this
// independently versioned deployment package.
import { SimpleAccount } from "@account-abstraction/contracts/samples/SimpleAccount.sol";
import { SimpleAccountFactory } from "@account-abstraction/contracts/samples/SimpleAccountFactory.sol";

contract FactoryImports {
    function versions() external pure returns (string memory account, string memory factory) {
        account = "SimpleAccount-v0.7";
        factory = "SimpleAccountFactory-v0.7";
    }
}
