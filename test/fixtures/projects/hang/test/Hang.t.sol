// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {Counter} from "../src/Counter.sol";

/// The timeout fixture (FR-37). An unbounded loop is no good: it runs out of the ~1.07e9 default
/// test gas in under a second. vm.sleep blocks the forge process for real.
contract HangTest is Test {
    Counter internal counter;

    function setUp() public {
        counter = new Counter();
    }

    function test_hangs() public {
        vm.sleep(600_000);
        counter.increment();
    }

    function test_quick() public {
        counter.increment();
        assertEq(counter.number(), 1);
    }
}
