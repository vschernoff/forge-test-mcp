// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {Warn} from "../src/Warn.sol";

contract WarnTest is Test {
    function test_g() public {
        assertEq(new Warn().g(3), 3);
    }
}
