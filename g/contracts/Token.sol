// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";

/**
 * @title ProjectToken
 * @dev توكن ERC20 Trust-Minimized — TRULY IMMUTABLE بعد finalize()
 * 
 * ⚠️ ملاحظات أمان:
 * - Minting يتم مرة واحدة فقط في Constructor (totalMinted == MAX_SUPPLY)
 * - لا يوجد Pause, Blacklist, Owner, أو strictApprove
 * - كل الإدارة عبر TimelockController قبل finalize()
 * - بعد finalize():
 *   • لا يوجد أدوار
 *   • لا يمكن إضافة أدوار (role admin = bytes32(0))
 *   • لا يمكن إلغاء أدوار
 *   • العقد immutable بالكامل
 * - pair مستثنى من maxWallet دائماً (مع null safety)
 * - DEX contracts validated (must be contracts)
 */
contract ProjectToken is ERC20, ERC20Burnable, AccessControl {
    
    // ═════════════════════════════════════════════════════════════
    // CONSTANTS
    // ═════════════════════════════════════════════════════════════
    
    uint256 public constant MAX_SUPPLY = 1_000_000_000 * 10**18;
    uint256 public constant MAX_RECIPIENTS = 200;
    
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant DEX_MANAGER_ROLE = keccak256("DEX_MANAGER_ROLE");
    
    // ═════════════════════════════════════════════════════════════
    // STATE VARIABLES
    // ═════════════════════════════════════════════════════════════
    
    /// @dev عنوان TimelockController (مخزن صراحة)
    address public immutable timelock;
    
    /// @dev هل تم الانتهاء من الإعداد النهائي
    bool public finalized;
    
    /// @dev هل maxWallet مُعطل نهائياً (بعد finalize)
    bool public maxWalletDisabled;
    
    /// @dev حد المحفظة القصوى (0 = غير محدد)
    uint256 public maxWalletAmount;
    
    /// @dev عنوان Pair (يُضبط مرة واحدة)
    address public pair;
    
    /// @dev عنوان Router (يُضبط مرة واحدة)
    address public router;
    
    /// @dev إجمالي التوكنات المُنشأة (يجب أن يساوي MAX_SUPPLY)
    uint256 public totalMinted;
    
    /// @dev عناوين معفاة من حد المحفظة
    mapping(address => bool) public isExcludedFromLimits;
    
    // ═════════════════════════════════════════════════════════════
    // EVENTS
    // ═════════════════════════════════════════════════════════════
    
    event TokensMinted(address indexed to, uint256 amount);
    event TokensBurned(address indexed from, uint256 amount);
    event AddressExcluded(address indexed account, bool isExcluded);
    event MaxWalletUpdated(uint256 oldAmount, uint256 newAmount);
    event MaxWalletDisabled();
    event DEXSetup(address indexed pair, address indexed router);
    event Finalized();
    event ContractImmutable();
    event RoleRevoked(bytes32 indexed role, address indexed account);
    event TimelockSet(address indexed timelock);
    
    // ═════════════════════════════════════════════════════════════
    // MODIFIERS
    // ═════════════════════════════════════════════════════════════
    
    modifier onlyBeforeFinalize() {
        require(!finalized, "Contract is finalized");
        _;
    }
    
    modifier onlyActive() {
        require(!finalized, "Contract is finalized");
        _;
    }
    
    // ═════════════════════════════════════════════════════════════
    // CONSTRUCTOR — Minting يتم هنا فقط! (totalMinted == MAX_SUPPLY)
    // ═════════════════════════════════════════════════════════════
    
    constructor(
        string memory name,
        string memory symbol,
        address _timelock,
        address[] memory initialRecipients,
        uint256[] memory initialAmounts
    ) ERC20(name, symbol) {
        require(_timelock != address(0), "Invalid timelock");
        require(initialRecipients.length == initialAmounts.length, "Length mismatch");
        require(initialRecipients.length > 0, "Empty distribution");
        require(initialRecipients.length <= MAX_RECIPIENTS, "Too many recipients");
        
        // ✅ تخزين عنوان Timelock صراحة (immutable)
        timelock = _timelock;
        emit TimelockSet(_timelock);
        
        // إعداد الأدوار
        _grantRole(DEFAULT_ADMIN_ROLE, _timelock);
        _grantRole(ADMIN_ROLE, _timelock);
        _grantRole(DEX_MANAGER_ROLE, _timelock);
        
        // ✅ Minting يتم مرة واحدة فقط هنا! (totalMinted == MAX_SUPPLY)
        for (uint256 i = 0; i < initialRecipients.length; i++) {
            address to = initialRecipients[i];
            uint256 amount = initialAmounts[i];
            
            require(to != address(0), "Cannot mint to zero");
            require(amount > 0, "Amount must be > 0");
            
            totalMinted += amount;
            
            _mint(to, amount);
            emit TokensMinted(to, amount);
        }
        
        // ✅ التأكد من أن كل التوريد تم سكه
        require(totalMinted == MAX_SUPPLY, "Must mint max supply");
        require(totalMinted > 0, "No tokens minted");
        
        // تعيين maxWallet افتراضي (قابل للتعديل قبل finalize)
        maxWalletAmount = 10_000_000 * 10**18;
        
        // استثناء العناوين المهمة
        isExcludedFromLimits[_timelock] = true;
        emit AddressExcluded(_timelock, true);
    }
    
    // ═════════════════════════════════════════════════════════════
    // OVERRIDE: تقييد إدارة الأدوار (فقط Timelock + Role Admin)
    // ═════════════════════════════════════════════════════════════
    
    /**
     * @dev منع منح أي دور — فقط Timelock (صاحب Role Admin) يمكنه قبل finalize()
     */
    function grantRole(bytes32 role, address account) public override onlyBeforeFinalize {
        require(
            hasRole(getRoleAdmin(role), msg.sender) && msg.sender == timelock,
            "Only timelock with role admin can grant"
        );
        super.grantRole(role, account);
    }
    
    /**
     * @dev منع إلغاء الدور — فقط Timelock (صاحب Role Admin) يمكنه قبل finalize()
     */
    function revokeRole(bytes32 role, address account) public override onlyBeforeFinalize {
        require(
            hasRole(getRoleAdmin(role), msg.sender) && msg.sender == timelock,
            "Only timelock with role admin can revoke"
        );
        super.revokeRole(role, account);
    }
    
    /**
     * @dev التخلي عن الدور — فقط Timelock (لا يسمح للحساب نفسه)
     * 
     * ملاحظة: بعد finalize() لا يمكن لأي شخص التخلي عن الأدوار
     * لأن onlyBeforeFinalize يمنع ذلك
     */
    function renounceRole(bytes32 role, address callerAccount) public override onlyBeforeFinalize {
        require(msg.sender == timelock, "Only timelock can renounce roles");
        super.renounceRole(role, callerAccount);
    }
    
    // ═════════════════════════════════════════════════════════════
    // ADMIN FUNCTIONS (تتطلب Timelock)
    // ═════════════════════════════════════════════════════════════
    
    /**
     * @dev إعداد DEX — مرة واحدة فقط!
     * ✅ التحقق من أن العناوين هي عقود حقيقية
     */
    function setupDEX(address _pair, address _router) 
        external 
        onlyRole(DEX_MANAGER_ROLE) 
        onlyBeforeFinalize 
    {
        require(_pair != address(0), "Invalid pair");
        require(_router != address(0), "Invalid router");
        require(_pair.code.length > 0, "Pair must be contract");
        require(_router.code.length > 0, "Router must be contract");
        require(pair == address(0), "DEX already setup");
        require(router == address(0), "Router already set");
        
        pair = _pair;
        router = _router;
        
        isExcludedFromLimits[_pair] = true;
        isExcludedFromLimits[_router] = true;
        
        emit DEXSetup(_pair, _router);
        emit AddressExcluded(_pair, true);
        emit AddressExcluded(_router, true);
    }
    
    /**
     * @dev تعديل حد المحفظة — قبل finalize فقط
     */
    function setMaxWalletAmount(uint256 newAmount) 
        external 
        onlyRole(ADMIN_ROLE) 
        onlyBeforeFinalize 
    {
        require(newAmount > 0, "Amount must be > 0");
        require(newAmount <= MAX_SUPPLY, "Exceeds max supply");
        
        uint256 oldAmount = maxWalletAmount;
        maxWalletAmount = newAmount;
        
        emit MaxWalletUpdated(oldAmount, newAmount);
    }
    
    /**
     * @dev إضافة/إزالة استثناء من الحدود
     */
    function setExcludedFromLimits(address account, bool excluded) 
        external 
        onlyRole(ADMIN_ROLE) 
        onlyBeforeFinalize 
    {
        require(account != address(0), "Cannot exclude zero");
        isExcludedFromLimits[account] = excluded;
        emit AddressExcluded(account, excluded);
    }
    
    /**
     * @dev 🚨 FINALIZE — نقطة اللاعودة المطلقة!
     * 
     * ما يحدث:
     * 1. يتطلب إعداد DEX
     * 2. يُعطل maxWallet
     * 3. يُلغي كل الأدوار من Timelock
     * 4. يُعطل إدارة الأدوال نهائياً (_setRoleAdmin → bytes32(0))
     * 5. لا يمكن إضافة أي دور بعد الآن
     * 6. العقد immutable بالكامل
     */
    function finalize() 
        external 
        onlyRole(ADMIN_ROLE) 
        onlyBeforeFinalize 
    {
        // ✅ تأكيدات مضاعفة: لا يمكن finalize مرتين
        require(finalized == false, "Already finalized");
        require(!maxWalletDisabled, "Already finalized");
        
        // ✅ يتطلب إعداد DEX قبل finalize
        require(pair != address(0), "DEX not set");
        require(router != address(0), "Router not set");
        
        // ✅ التحقق الدفاعي من وجود أدوار غير متوقعة
        require(
    hasRole(ADMIN_ROLE, timelock),
    "Timelock missing ADMIN_ROLE");
        require(hasRole(DEX_MANAGER_ROLE, timelock), "Timelock missing DEX role");
        require(!hasRole(DEX_MANAGER_ROLE, address(this)), "Contract holds role");
        
        // ✅ التحقق من أن Timelock لديه ADMIN_ROLE
        require(hasRole(ADMIN_ROLE, timelock), "Timelock missing ADMIN_ROLE");
        
        // ✅ التحقق من أن العقد نفسه لا يملك أدوار
        require(!hasRole(ADMIN_ROLE, address(this)), "Contract holds role");
        
        // ✅ التحقق من أن Role Admin مُضبط (ليس صفر)
        require(getRoleAdmin(ADMIN_ROLE) != bytes32(0), "Role admin not set");
        require(getRoleAdmin(DEX_MANAGER_ROLE) != bytes32(0), "Role admin not set");
        
        finalized = true;
        
        // ✅ إلغاء maxWallet نهائياً
        maxWalletDisabled = true;
        maxWalletAmount = 0;
        emit MaxWalletDisabled();
        
        // ✅ إلغاء كل الأدوار من Timelock (المخزن صراحة)
        _revokeRole(DEX_MANAGER_ROLE, timelock);
        _revokeRole(ADMIN_ROLE, timelock);
        _revokeRole(DEFAULT_ADMIN_ROLE, timelock);
        
        emit RoleRevoked(DEX_MANAGER_ROLE, timelock);
        emit RoleRevoked(ADMIN_ROLE, timelock);
        emit RoleRevoked(DEFAULT_ADMIN_ROLE, timelock);
        
        // ✅ 🚨 تعطيل إدارة الأدوال نهائياً!
        _setRoleAdmin(DEFAULT_ADMIN_ROLE, bytes32(0));
        _setRoleAdmin(ADMIN_ROLE, bytes32(0));
        _setRoleAdmin(DEX_MANAGER_ROLE, bytes32(0));
        
        emit Finalized();
        emit ContractImmutable();
    }
    
    // ═════════════════════════════════════════════════════════════
    // BURN FUNCTIONS (متاحة للجميع — Decentralized)
    // ═════════════════════════════════════════════════════════════
    
    function burn(uint256 amount) public override {
        require(amount > 0, "Amount must be > 0");
        super.burn(amount);
        emit TokensBurned(msg.sender, amount);
    }
    
    function burnFrom(address account, uint256 amount) public override {
        require(amount > 0, "Amount must be > 0");
        super.burnFrom(account, amount);
        emit TokensBurned(account, amount);
    }
    
    // ═════════════════════════════════════════════════════════════
    // STANDARD ERC20 APPROVE (Full DEX Compatibility)
    // ═════════════════════════════════════════════════════════════
    
    /**
     * @dev approve قياسي — لا يوجد strictApprove
     * ✅ توافق كامل مع Uniswap, PancakeSwap, routers, aggregators
     */
    function approve(address spender, uint256 amount)
    public
    override
    returns (bool)
    {
    return super.approve(spender, amount);
     }
    
    // ═════════════════════════════════════════════════════════════
    // INTERNAL FUNCTIONS
    // ═════════════════════════════════════════════════════════════
    
    function _update(
        address from,
        address to,
        uint256 amount
    ) internal override {
        // ✅ لا يوجد Pause!
        // ✅ لا يوجد Blacklist!
        
        // التحقق من حد المحفظة (إذا لم يُعطل)
        if (to != address(0) && !maxWalletDisabled) {
            _checkMaxWalletBefore(to, amount);
        }
        
        super._update(from, to, amount);
    }
    
    /**
     * @dev التحقق من حد المحفظة
     * ✅ pair مستثنى دائماً (مع null safety)
     */
    function _checkMaxWalletBefore(address account, uint256 amount) internal view {
        // ✅ null safety: التحقق من أن pair مُضبط قبل المقارنة
        if (pair != address(0) && account == pair) return;
        
        if (maxWalletAmount > 0 && !isExcludedFromLimits[account]) {
            require(balanceOf(account) + amount <= maxWalletAmount, "Exceeds max wallet");
        }
        }
    
    // ═════════════════════════════════════════════════════════════
    // VIEW FUNCTIONS
    // ═════════════════════════════════════════════════════════════
    
    /**
     * @dev التحقق من حالة التفعيل النهائي
     */
    function isFinalized() external view returns (bool) {
        return finalized;
    }
    
    /**
     * @dev التحقق من أن العقد immutable (شامل)
     */
    function isImmutable() external view returns (bool) {
        return finalized 
            && maxWalletDisabled 
            && getRoleAdmin(ADMIN_ROLE) == bytes32(0)
            && getRoleAdmin(DEX_MANAGER_ROLE) == bytes32(0);
    }
    
    /**
     * @dev التحقق من حالة العقد
     */
    function getTokenStatus() 
        external 
        view 
        returns (
            bool _finalized,
            bool _maxWalletDisabled,
            uint256 _maxWalletAmount,
            address _pair,
            address _router,
            uint256 _totalMinted,
            uint256 _totalSupply,
            address _timelock,
            bool _isImmutable
        ) 
    {
        return (
            finalized,
            maxWalletDisabled,
            maxWalletAmount,
            pair,
            router,
            totalMinted,
            totalSupply(),
            timelock,
            this.isImmutable()
        );
    }
    
    /**
     * @dev التحقق من وجود دور
     */
    function hasAdminRole(address account) external view returns (bool) {
        return hasRole(ADMIN_ROLE, account);
    }
    
    function hasDexManagerRole(address account) external view returns (bool) {
        return hasRole(DEX_MANAGER_ROLE, account);
    }
    
    function hasDefaultAdminRole(address account) external view returns (bool) {
        return hasRole(DEFAULT_ADMIN_ROLE, account);
    }
}
