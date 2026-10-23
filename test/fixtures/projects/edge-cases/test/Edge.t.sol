// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test, console} from "forge-std/Test.sol";
import {Counter} from "../src/Counter.sol";

contract SetUpFailsTest is Test {
    function setUp() public pure {
        revert("setUp exploded");
    }

    function test_neverRuns() public pure {
        assertTrue(true);
    }
}

contract EdgeTest is Test {
    Counter internal counter;

    function setUp() public {
        counter = new Counter();
    }

    function test_skipped() public {
        vm.skip(true);
    }

    function test_logsThenFails() public {
        console.log("about to fail, number =", counter.number());
        emit log_named_uint("custom log", 42);
        assertEq(counter.number(), 7);
    }

    function test_forkWithoutRpc() public {
        vm.createSelectFork("mainnet");
    }

    function test_deepTrace() public {
        _rec(12);
    }

    function _rec(uint256 n) internal {
        if (n == 0) {
            counter.setNumber(1);
            assertEq(counter.number(), 2, "deep failure");
            return;
        }
        counter.increment();
        _rec(n - 1);
    }

    function test_hugeRevertString() public pure {
        revert(string(new bytes(4000)));
    }
}

contract EdgeFuzzRejectTest is Test {
    function testFuzz_tooManyRejects(uint256 x) public pure {
        vm.assume(x == 42);
    }
}
