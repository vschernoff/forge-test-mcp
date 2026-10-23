// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

contract Warn {
    function g(uint256 a) public pure returns (uint256) {
        uint256 unused;
        return a;
    }
}
