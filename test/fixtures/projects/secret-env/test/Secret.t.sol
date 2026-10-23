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

    /// The same key read as a number reaches the output in decimal.
    function test_leaksDotenvAsNumber() public view {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        console.log("pk", pk);
        revert(vm.toString(pk));
    }

    /// An RPC URL with an API key in its path (D24). forge masks it in its own fork errors and
    /// traces ("<rpc url>"), but not when a test prints it.
    function test_leaksRpcUrl() public view {
        string memory url = vm.envString("MAINNET_RPC_URL");
        console.log("rpc", url);
        revert(string.concat("cannot reach ", url));
    }
}
