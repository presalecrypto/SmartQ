
# Airdrop.sol v2 - Trust-Minimized, compatible with Token.sol v7

airdrop_v2 = '''// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title Airdrop
 * @dev إيردروب Trust-Minimized — Merkle Root ثابت، Claim Trustless
 * 
 * ⚠️ ملاحظات أمان:
 * - MerkleRoot يُضبط مرة واحدة فقط (via Timelock)
 * - Deadline ثابت وغير قابل للتغيير
 * - لا يوجد إعادة تفعيل بعد الإيقاف
 * - السحب فقط بعد Deadline
 * - لا يوجد Pause أو Owner
 * - متوافق مع Token.sol v7 (standard ERC20 approve)
 */
contract Airdrop is AccessControl, ReentrancyGuard {
    
    // ═════════════════════════════════════════════════════════════
    // CONSTANTS
    // ═════════════════════════════════════════════════════════════
    
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    
    // ═════════════════════════════════════════════════════════════
    // STATE VARIABLES
    // ═════════════════════════════════════════════════════════════
    
    /// @dev عنوان التوكن (IERC20)
    IERC20 public immutable token;
    
    /// @dev عنوان TimelockController (مخزن صراحة)
    address public immutable timelock;
    
    /// @dev Merkle Root (يُضبط مرة واحدة فقط)
    bytes32 public merkleRoot;
    
    /// @dev هل تم تفعيل الإيردروب
    bool public isActive;
    
    /// @dev هل تم الإيقاف النهائي
    bool public permanentlyDeactivated;
    
    /// @dev هل تم الإعداد النهائي (لا يمكن تغيير أي شيء بعده)
    bool public finalized;
    
    /// @dev الموعد النهائي للمطالبة (ثابت)
    uint256 public deadline;
    
    /// @dev إجمالي التوكنات الموزعة
    uint256 public totalClaimed;
    
    /// @dev المستخدمون الذين طالبوا
    mapping(address => bool) public hasClaimed;
    
    // ═════════════════════════════════════════════════════════════
    // EVENTS
    // ═════════════════════════════════════════════════════════════
    
    event MerkleRootSet(bytes32 indexed root, uint256 deadline);
    event TokensClaimed(address indexed user, uint256 amount, uint256 timestamp);
    event AirdropDeactivated();
    event RemainingTokensWithdrawn(address indexed to, uint256 amount);
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
        _grantRole(ADMIN_ROLE, _timelock);
        
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
    // ADMIN FUNCTIONS (Timelock فقط)
    // ═════════════════════════════════════════════════════════════
    
    /**
     * @dev تفعيل الإيردروب — مرة واحدة فقط!
     */
    function setMerkleRoot(
        bytes32 _merkleRoot, 
        uint256 _deadline
    ) 
        external 
        onlyRole(ADMIN_ROLE) 
        onlyBeforeFinalize
    {
        require(!isActive, "Already active");
        require(!permanentlyDeactivated, "Permanently deactivated");
        require(_merkleRoot != bytes32(0), "Invalid root");
        require(_deadline > block.timestamp, "Deadline must be future");
        require(_deadline > block.timestamp + 1 days, "Deadline too short");
        
        merkleRoot = _merkleRoot;
        deadline = _deadline;
        isActive = true;
        
        emit MerkleRootSet(_merkleRoot, _deadline);
    }
    
    /**
     * @dev إيقاف الإيردروب (قبل Deadline) — لا يمكن إعادة التفعيل!
     */
    function deactivate() 
        external 
        onlyRole(ADMIN_ROLE) 
        onlyBeforeFinalize
    {
        require(isActive, "Not active");
        require(!permanentlyDeactivated, "Already deactivated");
        require(block.timestamp < deadline, "Deadline passed");
        
        isActive = false;
        permanentlyDeactivated = true;
        
        emit AirdropDeactivated();
    }
    
    /**
     * @dev سحب التوكنات المتبقية — فقط بعد Deadline!
     */
    function withdrawRemaining() 
        external 
        onlyRole(ADMIN_ROLE) 
        nonReentrant
    {
        require(block.timestamp > deadline, "Deadline not reached");
        require(deadline != 0, "Deadline not set");
        
        uint256 balance = token.balanceOf(address(this));
        require(balance > 0, "No tokens remaining");
        
        require(token.transfer(timelock, balance), "Transfer failed");
        
        emit RemainingTokensWithdrawn(timelock, balance);
    }
    
    /**
     * @dev 🚨 FINALIZE — نقطة اللاعودة!
     * بعد هذا لا يمكن تغيير أي شيء
     */
    function finalize()
        external
        onlyRole(ADMIN_ROLE)
        onlyBeforeFinalize
    {
        require(isActive, "Airdrop not active");
        require(deadline != 0, "Deadline not set");
        require(merkleRoot != bytes32(0), "Merkle root not set");
        
        finalized = true;
        
        // إلغاء الأدوار من Timelock
        _revokeRole(ADMIN_ROLE, timelock);
        _revokeRole(DEFAULT_ADMIN_ROLE, timelock);
        
        // تعطيل إدارة الأدوال نهائياً
        _setRoleAdmin(ADMIN_ROLE, bytes32(0));
        _setRoleAdmin(DEFAULT_ADMIN_ROLE, bytes32(0));
        
        emit ContractImmutable();
    }
    
    // ═════════════════════════════════════════════════════════════
    // CLAIM — TRUSTLESS!
    // ═════════════════════════════════════════════════════════════
    
    /**
     * @dev المطالبة بالإيردروب — لا يحتاج موافقة أحد!
     * متوافق مع Token.sol v7 (standard ERC20 approve)
     */
    function claim(
        uint256 amount,
        bytes32[] calldata merkleProof
    ) 
        external 
        nonReentrant 
    {
        require(isActive, "Airdrop not active");
        require(!permanentlyDeactivated, "Permanently deactivated");
        require(block.timestamp <= deadline, "Deadline passed");
        require(!hasClaimed[msg.sender], "Already claimed");
        
        // ✅ OpenZeppelin MerkleProof (double hash)
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(msg.sender, amount))));
        
        require(
            MerkleProof.verify(merkleProof, merkleRoot, leaf),
            "Invalid proof"
        );
        
        hasClaimed[msg.sender] = true;
        totalClaimed += amount;
        
        require(token.transfer(msg.sender, amount), "Transfer failed");
        
        emit TokensClaimed(msg.sender, amount, block.timestamp);
    }
    
    // ═════════════════════════════════════════════════════════════
    // VIEW FUNCTIONS
    // ═════════════════════════════════════════════════════════════
    
    /**
     * @dev التحقق من صلاحية المطالبة (بدون تنفيذ)
     */
    function verifyClaim(
        address user,
        uint256 amount,
        bytes32[] calldata merkleProof
    ) 
        external 
        view 
        returns (bool valid, bool claimed, bool expired) 
    {
        claimed = hasClaimed[user];
        expired = block.timestamp > deadline && deadline != 0;
        
        if (claimed || expired || !isActive) {
            return (false, claimed, expired);
        }
        
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(user, amount))));
        valid = MerkleProof.verify(merkleProof, merkleRoot, leaf);
        
        return (valid, claimed, expired);
    }
    
    /**
     * @dev معلومات عامة عن الإيردروب
     */
    function getAirdropInfo() 
        external 
        view 
        returns (
            bool active,
            bool deactivated,
            bool _finalized,
            uint256 _deadline,
            uint256 remaining,
            uint256 claimed,
            uint256 timeLeft
        ) 
    {
        active = isActive;
        deactivated = permanentlyDeactivated;
        _finalized = finalized;
        _deadline = deadline;
        remaining = token.balanceOf(address(this));
        claimed = totalClaimed;
        
        if (block.timestamp >= deadline || deadline == 0) {
            timeLeft = 0;
        } else {
            timeLeft = deadline - block.timestamp;
        }
    }
    
    /**
     * @dev هل المستخدم طالب
     */
    function hasUserClaimed(address user) external view returns (bool) {
        return hasClaimed[user];
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
        return finalized && getRoleAdmin(ADMIN_ROLE) == bytes32(0);
    }
}'''