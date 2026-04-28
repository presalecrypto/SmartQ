// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title Vesting
 * @dev نظام Vesting Trust-Minimized — جداول غير قابلة للتعديل بعد الإنشاء
 * 
 * ⚠️ ملاحظات أمان:
 * - لا يوجد Pause أو Owner
 * - FUNDER_ROLE يُمنح فقط عبر Timelock
 * - الجداول immutable بعد الإنشاء (لا cancel, لا edit)
 * - المستخدم يستدعي release() بنفسه (trustless)
 * - متوافق مع Token.sol v7 (standard ERC20 approve/transfer)
 */
contract Vesting is AccessControl, ReentrancyGuard {
    
    // ═════════════════════════════════════════════════════════════
    // CONSTANTS
    // ═════════════════════════════════════════════════════════════
    
    bytes32 public constant FUNDER_ROLE = keccak256("FUNDER_ROLE");
    
    uint256 public constant CLIFF = 30 days;
    uint256 public constant VESTING_DURATION = 90 days;
    
    // ═════════════════════════════════════════════════════════════
    // STATE VARIABLES
    // ═════════════════════════════════════════════════════════════
    
    /// @dev عنوان التوكن (IERC20)
    IERC20 public immutable token;
    
    /// @dev عنوان TimelockController (مخزن صراحة)
    address public immutable timelock;
    
    /// @dev هل تم الإعداد النهائي (لا يمكن إنشاء جداول جديدة)
    bool public finalized;
    
    struct VestingSchedule {
        uint256 totalAmount;
        uint256 releasedAmount;
        uint256 startTime;
        address beneficiary;
        bool initialized;
        address createdBy;
        bool immediateReleased;
    }
    
    /// @dev جداول الاستحقاق (beneficiary => schedule)
    mapping(address => VestingSchedule) public vestingSchedules;
    
    /// @dev قائمة المستفيدين (للعرض)
    address[] public beneficiaries;
    
    /// @dev إجمالي التوكنات المستثمرة
    uint256 public totalVested;
    
    /// @dev إجمالي التوكنات المُحررة
    uint256 public totalReleased;
    
    // ═════════════════════════════════════════════════════════════
    // EVENTS
    // ═════════════════════════════════════════════════════════════
    
    event VestingCreated(
        address indexed beneficiary,
        uint256 totalAmount,
        uint256 immediateRelease,
        address indexed createdBy,
        uint256 startTime
    );
    
    event TokensReleased(
        address indexed beneficiary, 
        uint256 amount, 
        uint256 timestamp
    );
    
    event VestingCompleted(address indexed beneficiary);
    event ContractImmutable();
    event TimelockSet(address indexed timelock);
    
    // ═════════════════════════════════════════════════════════════
    // MODIFIERS
    // ═════════════════════════════════════════════════════════════
    
    modifier onlyBeforeFinalize() {
        require(!finalized, "Contract is finalized");
        _;
    }
    
    // ═════════════════════════════════════════════════════════════
    // CONSTRUCTOR
    // ═════════════════════════════════════════════════════════════
    
    constructor(
        address _token, 
        address _timelock
    ) {
        require(_token != address(0), "Invalid token");
        require(_token.code.length > 0, "Token must be contract");
        require(_timelock != address(0), "Invalid timelock");
        
        token = IERC20(_token);
        timelock = _timelock;
        
        _grantRole(DEFAULT_ADMIN_ROLE, _timelock);
        _grantRole(FUNDER_ROLE, _timelock);
        
        emit TimelockSet(_timelock);
    }
    
    // ═════════════════════════════════════════════════════════════
    // OVERRIDE: تقييد إدارة الأدوار (فقط Timelock)
    // ═════════════════════════════════════════════════════════════
    
    function grantRole(bytes32 role, address account) public override onlyBeforeFinalize {
        require(
            hasRole(getRoleAdmin(role), msg.sender) && msg.sender == timelock,
            "Only timelock with role admin can grant"
        );
        super.grantRole(role, account);
    }
    
    function revokeRole(bytes32 role, address account) public override onlyBeforeFinalize {
        require(
            hasRole(getRoleAdmin(role), msg.sender) && msg.sender == timelock,
            "Only timelock with role admin can revoke"
        );
        super.revokeRole(role, account);
    }
    
    function renounceRole(bytes32 role, address callerAccount) public override onlyBeforeFinalize {
        require(msg.sender == timelock, "Only timelock can renounce roles");
        super.renounceRole(role, callerAccount);
    }
    
    // ═════════════════════════════════════════════════════════════
    // CREATE VESTING (FUNDER_ROLE فقط — Timelock)
    // ═════════════════════════════════════════════════════════════
    
    /**
     * @dev إنشاء جدول استحقاق — غير قابل للتعديل بعد الإنشاء!
     * قبل finalize فقط
     */
    function createVesting(
        address beneficiary,
        uint256 amount
    )
        external
        nonReentrant
        onlyRole(FUNDER_ROLE)
        onlyBeforeFinalize
    {
        require(beneficiary != address(0), "Zero address");
        require(amount > 0, "Amount must be > 0");
        require(!vestingSchedules[beneficiary].initialized, "Already exists");
        
        // ✅ التحقق من السماحية قبل التحويل (Token.sol v7 compatible)
        bool success = token.transferFrom(msg.sender, address(this), amount);
        require(success, "Transfer failed");
        
        // 25% تحرير فوري، 75% استحقاق
        uint256 immediateRelease = amount / 4;
        uint256 vested = amount - immediateRelease;
        
        vestingSchedules[beneficiary] = VestingSchedule({
            totalAmount: vestedAmount (beneficiary),
            releasedAmount: 0,
            startTime: block.timestamp,
            beneficiary: beneficiary,
            initialized: true,
            createdBy: msg.sender,
            immediateReleased: false
        });
        
        beneficiaries.push(beneficiary);
        totalVested += vestedAmount(beneficiary);
        
        // تحرير الفوري
        if (immediateRelease > 0) {
            vestingSchedules[beneficiary].immediateReleased = true;
            totalReleased += immediateRelease;
            
            require(token.transfer(beneficiary, immediateRelease), "Immediate transfer failed");
        }
        
        emit VestingCreated(
            beneficiary, 
            amount, 
            immediateRelease, 
            msg.sender, 
            block.timestamp
        );
    }
    
    // ═════════════════════════════════════════════════════════════
    // CORE LOGIC — SAFE + PRECISION FIX
    // ═════════════════════════════════════════════════════════════
    
    /**
     * @dev حساب المبلغ القابل للتحرير حالياً
     */
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
    
    /**
     * @dev حساب المبلغ المحرر بالكامل (المستحق + المحرر فعلياً)
     */
    function vestedAmount(address beneficiary) public view returns (uint256) {
        VestingSchedule storage s = vestingSchedules[beneficiary];
        
        if (!s.initialized) return 0;
        
        uint256 elapsed = block.timestamp - s.startTime;
        
        if (elapsed < CLIFF) return 0;
        
        if (elapsed >= VESTING_DURATION) {
            return s.totalAmount;
        }
        
        uint256 vestedTime = elapsed - CLIFF;
        uint256 vestingTime = VESTING_DURATION - CLIFF;
        
        return (s.totalAmount * vestedTime) / vestingTime;
    }
    
    // ═════════════════════════════════════════════════════════════
    // RELEASE — TRUSTLESS (المستخدم يستدعي بنفسه)
    // ═════════════════════════════════════════════════════════════
    
    /**
     * @dev تحرير التوكنات المستحقة — لا يحتاج موافقة أحد!
     * متوافق مع Token.sol v7 (standard ERC20 transfer)
     */
    function release() external nonReentrant {
        VestingSchedule storage s = vestingSchedules[msg.sender];
        
        require(s.initialized, "No vesting found");
        
        uint256 amount = releasableAmount(msg.sender);
        require(amount > 0, "Nothing to release");
        
        s.releasedAmount += amount;
        totalReleased += amount;
        totalVested -= amount;
        
        require(token.transfer(msg.sender, amount), "Transfer failed");
        
        emit TokensReleased(msg.sender, amount, block.timestamp);
        
        if (s.releasedAmount == s.totalAmount) {
            emit VestingCompleted(msg.sender);
        }
    }
    
    /**
     * @dev تحرير متعدد — يمكن لأي شخص استدعائه (trustless)
     * متوافق مع Token.sol v7
     */
    function releaseBatch(address[] calldata users) external nonReentrant {
        for (uint256 i = 0; i < users.length; i++) {
            address user = users[i];
            VestingSchedule storage s = vestingSchedules[user];
            
            if (s.initialized) {
                uint256 amount = releasableAmount(user);
                if (amount > 0) {
                    s.releasedAmount += amount;
                    totalReleased += amount;
                    totalVested -= amount;
                    
                    require(token.transfer(user, amount), "Transfer failed");
                    
                    emit TokensReleased(user, amount, block.timestamp);
                    
                    if (s.releasedAmount == s.totalAmount) {
                        emit VestingCompleted(user);
                    }
                }
            }
        }
    }
    
    // ═════════════════════════════════════════════════════════════
    // FINALIZE — نقطة اللاعودة!
    // ═════════════════════════════════════════════════════════════
    
    /**
     * @dev 🚨 FINALIZE — لا يمكن إنشاء جداول جديدة بعدها!
     * الجداول الموجودة تبقى تعمل (trustless release)
     */
    function finalize()
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
        onlyBeforeFinalize
    {
        require(beneficiaries.length > 0, "No vesting schedules");
        
        finalized = true;
        
        // إلغاء الأدوار من Timelock
        _revokeRole(FUNDER_ROLE, timelock);
        _revokeRole(DEFAULT_ADMIN_ROLE, timelock);
        
        // تعطيل إدارة الأدوال نهائياً
        _setRoleAdmin(FUNDER_ROLE, bytes32(0));
        _setRoleAdmin(DEFAULT_ADMIN_ROLE, bytes32(0));
        
        emit ContractImmutable();
    }
    
    // ═════════════════════════════════════════════════════════════
    // VIEW FUNCTIONS — FULL TRANSPARENCY
    // ═════════════════════════════════════════════════════════════
    
    /**
     * @dev معلومات كاملة عن جدول الاستحقاق
     */
    function getVestingInfo(address beneficiary)
        external
        view
        returns (
            uint256 total,
            uint256 released,
            uint256 releasable,
            uint256 vested,
            uint256 startTime,
            uint256 endTime,
            uint256 cliffEnd,
            address creator,
            bool isComplete
        )
    {
        VestingSchedule storage s = vestingSchedules[beneficiary];
        
        if (!s.initialized) {
            return (0, 0, 0, 0, 0, 0, 0, address(0), false);
        }
        
        uint256 _releasable = releasableAmount(beneficiary);
        uint256 _vested = vestedAmount(beneficiary);
        bool _isComplete = s.releasedAmount == s.totalAmount;
        
        return (
            s.totalAmount,
            s.releasedAmount,
            _releasable,
            _vested,
            s.startTime,
            s.startTime + VESTING_DURATION,
            s.startTime + CLIFF,
            s.createdBy,
            _isComplete
        );
    }
    
    /**
     * @dev قائمة جميع المستفيدين
     */
    function getAllBeneficiaries() external view returns (address[] memory) {
        return beneficiaries;
    }
    
    /**
     * @dev عدد المستفيدين
     */
    function getBeneficiariesCount() external view returns (uint256) {
        return beneficiaries.length;
    }
    
    /**
     * @dev إجمالي التوكنات في العقد
     */
    function getContractBalance() external view returns (uint256) {
        return token.balanceOf(address(this));
    }
    
    /**
     * @dev التحقق من اكتمال الاستحقاق
     */
    function isVestingComplete(address beneficiary) external view returns (bool) {
        VestingSchedule storage s = vestingSchedules[beneficiary];
        if (!s.initialized) return false;
        return s.releasedAmount == s.totalAmount;
    }
    
    /**
     * @dev الوقت المتبقي للاستحقاق الكامل
     */
    function timeRemaining(address beneficiary) external view returns (uint256) {
        VestingSchedule storage s = vestingSchedules[beneficiary];
        if (!s.initialized) return 0;
        
        uint256 endTime = s.startTime + VESTING_DURATION;
        if (block.timestamp >= endTime) return 0;
        
        return endTime - block.timestamp;
    }
    
    /**
     * @dev التحقق من حالة التفعيل النهائي
     */
    function isFinalized() external view returns (bool) {
        return finalized;
    }
    
    /**
     * @dev التحقق من أن العقد immutable
     */
    function isImmutable() external view returns (bool) {
        return finalized && getRoleAdmin(FUNDER_ROLE) == bytes32(0);
    }
    
    /**
     * @dev معلومات عامة عن العقد
     */
    function getVestingStatus()
        external
        view
        returns (
            bool _finalized,
            uint256 _totalVested,
            uint256 _totalReleased,
            uint256 _balance,
            uint256 _beneficiariesCount,
            bool _isImmutable
        )
    {
        return (
            finalized,
            totalVested,
            totalReleased,
            token.balanceOf(address(this)),
            beneficiaries.length,
            this.isImmutable()
        );
    }
}