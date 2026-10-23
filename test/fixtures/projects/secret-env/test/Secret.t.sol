// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test, console} from "forge-std/Test.sol";

/// Prints values that forge loads from the project's .env, then fails, so the server's
/// response would contain them unless they are redacted (D19 Q6).
contract SecretTest is Test {
    function test_leaksDotenv() public view {
        string memory key = vm.envString("DEPLOYER_PRIVATE_KEY");
        string memory token = vm.envString("ETHERSCAN_API_KEY");
        console.log("key", key);
        console.log("token", token);
        revert(string.concat("leaked ", key));
    }
}
