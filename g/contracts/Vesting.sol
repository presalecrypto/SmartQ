// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title Vesting (Institutional Trust-Minimized Version)
 * @dev نظام Vesting مؤسسي شبه لامركزي (Governance-ready)
 */
contract Vesting is Ownable, AccessControl, Pausable, ReentrancyGuard {

    IERC20 public immutable token;

    bytes32 public constant FUNDER_ROLE = keccak256("FUNDER_ROLE");

    uint256 public constant CLIFF = 30 days;
    uint256 public constant VESTING_DURATION = 90 days;

    struct VestingSchedule {
        uint256 totalAmount;
        uint256 releasedAmount;
        uint256 startTime;
        address beneficiary;
        bool initialized;
        address createdBy;
    }

    mapping(address => VestingSchedule) public vestingSchedules;

    uint256 public totalVested;

    // ═══════════════════════════════
    // EVENTS (Audit-grade)
    // ═══════════════════════════════

    event VestingCreated(
        address indexed beneficiary,
        uint256 totalAmount,
        uint256 immediateRelease,
        address indexed createdBy
    );

    event TokensReleased(address indexed beneficiary, uint256 amount);
    event VestingCompleted(address indexed beneficiary);
    event EmergencyPause(address indexed by);
    event EmergencyUnpause(address indexed by);

    constructor(address _token, address initialOwner) Ownable(initialOwner) {
        require(_token != address(0), "Invalid token");
        token = IERC20(_token);

        _grantRole(DEFAULT_ADMIN_ROLE, initialOwner);
        _grantRole(FUNDER_ROLE, initialOwner);
    }

    // ═══════════════════════════════
    // GOVERNANCE LEVEL CONTROL (NOT CENTRALIZED EXECUTION)
    // ═══════════════════════════════

    function addFunder(address funder) external onlyOwner {
        grantRole(FUNDER_ROLE, funder);
    }

    function removeFunder(address funder) external onlyOwner {
        revokeRole(FUNDER_ROLE, funder);
    }

    function pause() external onlyOwner {
        _pause();
        emit EmergencyPause(msg.sender);
    }

    function unpause() external onlyOwner {
        _unpause();
        emit EmergencyUnpause(msg.sender);
    }

    // ═══════════════════════════════
    // CREATE VESTING (NOT PURE OWNER DEPENDENT)
    // ═══════════════════════════════

    function createVesting(
        address beneficiary,
        uint256 amount
    )
        external
        whenNotPaused
        nonReentrant
        onlyRole(FUNDER_ROLE)
    {
        require(beneficiary != address(0), "Zero address");
        require(amount > 0, "Amount must be > 0");
        require(!vestingSchedules[beneficiary].initialized, "Already exists");

        bool success = token.transferFrom(msg.sender, address(this), amount);
        require(success, "Transfer failed");

        uint256 immediateRelease = amount / 4;
        uint256 vestedAmount = amount - immediateRelease;

        vestingSchedules[beneficiary] = VestingSchedule({
            totalAmount: vestedAmount,
            releasedAmount: 0,
            startTime: block.timestamp,
            beneficiary: beneficiary,
            initialized: true,
            createdBy: msg.sender
        });

        totalVested += vestedAmount;

        if (immediateRelease > 0) {
            require(token.transfer(beneficiary, immediateRelease), "Immediate transfer failed");
        }

        emit VestingCreated(beneficiary, amount, immediateRelease, msg.sender);
    }

    // ═══════════════════════════════
    // CORE LOGIC (SAFE + PRECISION FIX)
    // ═══════════════════════════════

    function releasableAmount(address beneficiary) public view returns (uint256) {
        VestingSchedule storage s = vestingSchedules[beneficiary];

        if (!s.initialized) return 0;

        uint256 elapsed = block.timestamp - s.startTime;

        if (elapsed < CLIFF) return 0;

        if (elapsed >= VESTING_DURATION) {
            return s.totalAmount - s.releasedAmount;
        }

        uint256 vestedTime = elapsed - CLIFF;
        uint256 vestingTime = VESTING_DURATION - CLIFF;

        uint256 vested = (s.totalAmount * vestedTime) / vestingTime;

        if (vested <= s.releasedAmount) return 0;

        return vested - s.releasedAmount;
    }

    // ═══════════════════════════════
    // RELEASE (DECENTRALIZED USER CONTROL)
    // ═══════════════════════════════

    function release() external nonReentrant whenNotPaused {
        VestingSchedule storage s = vestingSchedules[msg.sender];

        require(s.initialized, "No vesting");

        uint256 amount = releasableAmount(msg.sender);
        require(amount > 0, "Nothing to release");

        s.releasedAmount += amount;
        totalVested -= amount;

        require(token.transfer(msg.sender, amount), "Transfer failed");

        emit TokensReleased(msg.sender, amount);

        if (s.releasedAmount == s.totalAmount) {
            emit VestingCompleted(msg.sender);
        }
    }

    // ═══════════════════════════════
    // VIEW (AUDIT-READY)
    // ═══════════════════════════════

    function getVestingInfo(address beneficiary)
        external
        view
        returns (
            uint256 total,
            uint256 released,
            uint256 releasable,
            uint256 startTime,
            address creator
        )
    {
        VestingSchedule storage s = vestingSchedules[beneficiary];

        if (!s.initialized) {
            return (0, 0, 0, 0, address(0));
        }

        return (
            s.totalAmount,
            s.releasedAmount,
            releasableAmount(beneficiary),
            s.startTime,
            s.createdBy
        );
    }
}