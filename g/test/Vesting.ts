// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title Vesting
 * @dev Vesting contract محسّن (آمن + منطقي + قابل للإنتاج)
 */
contract Vesting is Ownable, ReentrancyGuard {
    
    IERC20 public immutable token;

    // ═══════════════════════════════════════
    // CONFIG
    // ═══════════════════════════════════════
    
    uint256 public constant CLIFF = 30 days;
    uint256 public constant VESTING_DURATION = 90 days;

    // ═══════════════════════════════════════
    // STRUCT
    // ═══════════════════════════════════════
    
    struct VestingSchedule {
        uint256 totalAmount;
        uint256 releasedAmount;
        uint256 startTime;
        bool initialized;
    }

    mapping(address => VestingSchedule) public vestingSchedules;
    uint256 public totalVested;

    // ═══════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════
    
    event VestingCreated(address indexed beneficiary, uint256 totalAmount, uint256 immediateRelease);
    event TokensReleased(address indexed beneficiary, uint256 amount);
    event VestingCompleted(address indexed beneficiary);
    event VestingCancelled(address indexed beneficiary, uint256 recoveredAmount);

    // ═══════════════════════════════════════
    // CONSTRUCTOR
    // ═══════════════════════════════════════
    
    constructor(address _token, address initialOwner) Ownable(initialOwner) {
        require(_token != address(0), "Invalid token address");
        token = IERC20(_token);
    }

    // ═══════════════════════════════════════
    // CREATE VESTING
    // ═══════════════════════════════════════
    
    function createVesting(
        address beneficiary,
        uint256 amount
    ) external onlyOwner nonReentrant {
        require(beneficiary != address(0), "Zero address");
        require(amount > 0, "Amount must be > 0");
        require(!vestingSchedules[beneficiary].initialized, "Already exists");

        // 🔥 FIX مهم: يجب أن يكون لدى الـ owner رصيد كافي قبل النقل
        require(token.balanceOf(msg.sender) >= amount, "Insufficient owner balance");

        require(
            token.transferFrom(msg.sender, address(this), amount),
            "Transfer failed"
        );

        uint256 immediateRelease = amount / 4;
        uint256 vestedAmount = amount - immediateRelease;

        vestingSchedules[beneficiary] = VestingSchedule({
            totalAmount: vestedAmount,
            releasedAmount: 0,
            startTime: block.timestamp,
            initialized: true
        });

        totalVested += vestedAmount;

        if (immediateRelease > 0) {
            require(token.transfer(beneficiary, immediateRelease), "Immediate transfer failed");
        }

        emit VestingCreated(beneficiary, amount, immediateRelease);
    }

    // ═══════════════════════════════════════
    // CORE LOGIC (CLIFF FIXED)
    // ═══════════════════════════════════════
    
    function releasableAmount(address beneficiary) public view returns (uint256) {
        VestingSchedule storage s = vestingSchedules[beneficiary];

        if (!s.initialized) return 0;

        uint256 elapsed = block.timestamp - s.startTime;

        if (elapsed < CLIFF) {
            return 0;
        }

        if (elapsed >= VESTING_DURATION) {
            return s.totalAmount - s.releasedAmount;
        }

        uint256 vestedTime = elapsed - CLIFF;
        uint256 vestingTime = VESTING_DURATION - CLIFF;

        uint256 vested = (s.totalAmount * vestedTime) / vestingTime;

        if (vested <= s.releasedAmount) return 0;

        return vested - s.releasedAmount;
    }

    // ═══════════════════════════════════════
    // RELEASE TOKENS
    // ═══════════════════════════════════════
    
    function release() external nonReentrant {
        VestingSchedule storage s = vestingSchedules[msg.sender];

        require(s.initialized, "No vesting");

        uint256 amount = releasableAmount(msg.sender);
        require(amount > 0, "Nothing to release");

        require(totalVested >= amount, "Internal accounting error");

        s.releasedAmount += amount;
        totalVested -= amount;

        require(token.transfer(msg.sender, amount), "Transfer failed");

        emit TokensReleased(msg.sender, amount);

        if (s.releasedAmount == s.totalAmount) {
            emit VestingCompleted(msg.sender);
        }
    }

    // ═══════════════════════════════════════
    // CANCEL VESTING
    // ═══════════════════════════════════════
    
    function cancelVesting(address beneficiary) external onlyOwner nonReentrant {
        VestingSchedule storage s = vestingSchedules[beneficiary];
        require(s.initialized, "No vesting");

        uint256 remaining = s.totalAmount - s.releasedAmount;

        require(totalVested >= remaining, "Internal accounting error");

        totalVested -= remaining;

        delete vestingSchedules[beneficiary];

        require(token.transfer(owner(), remaining), "Transfer failed");

        emit VestingCancelled(beneficiary, remaining);
    }

    // ═══════════════════════════════════════
    // VIEW INFO
    // ═══════════════════════════════════════
    
    function getVestingInfo(address beneficiary) external view returns (
        uint256 total,
        uint256 released,
        uint256 releasable,
        uint256 startTime,
        uint256 cliffEnd,
        uint256 endTime
    ) {
        VestingSchedule storage s = vestingSchedules[beneficiary];

        if (!s.initialized) {
            return (0, 0, 0, 0, 0, 0);
        }

        total = s.totalAmount;
        released = s.releasedAmount;
        releasable = releasableAmount(beneficiary);

        startTime = s.startTime;
        cliffEnd = s.startTime + CLIFF;
        endTime = s.startTime + VESTING_DURATION;
    }
}