// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title ProjectToken
 * @dev توكن ERC20 متقدم مع حماية شاملة
 * 
 * ⚠️ ملاحظات أمان:
 * - يجب استثناء LP Pair و Router بعد النشر
 * - Owner لديه صلاحيات عالية (يفضل Multi-sig)
 */
contract ProjectToken is ERC20, ERC20Burnable, Ownable, Pausable {
    
    uint256 public constant MAX_SUPPLY = 1_000_000_000 * 10**18;
    uint256 public constant MAX_BATCH_SIZE = 50;
    
    uint256 public maxWalletAmount = 10_000_000 * 10**18;
    mapping(address => bool) public blacklist;
    mapping(address => bool) public isExcludedFromLimits;
    bool public mintingFinished;
    bool public mintLockPermanent;
    
    event TokensMinted(address indexed to, uint256 amount);
    event TokensBurned(address indexed from, uint256 amount);
    event AddressBlacklisted(address indexed account, bool isBlacklisted);
    event AddressExcluded(address indexed account, bool isExcluded);
    event MaxWalletUpdated(uint256 oldAmount, uint256 newAmount);
    event MintingFinished();
    event MintingResumed();
    event MintLockMadePermanent();
    
    modifier notBlacklisted(address account) {
        require(!blacklist[account], "Address is blacklisted");
        _;
    }
    
    modifier whenMintingNotFinished() {
        require(!mintingFinished, "Minting is finished");
        _;
    }
    
    constructor(
        string memory name,
        string memory symbol,
        address initialOwner
    ) ERC20(name, symbol) Ownable(initialOwner) {
        isExcludedFromLimits[initialOwner] = true;
        emit AddressExcluded(initialOwner, true);
    }
    
    // ═════════════════════════════════════════════════════════════
    // ADMIN FUNCTIONS
    // ═════════════════════════════════════════════════════════════
    
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }
    
    function setBlacklist(address account, bool isBlacklisted_) external onlyOwner {
        require(account != address(0), "Cannot blacklist zero address");
        require(account != owner(), "Cannot blacklist owner");
        blacklist[account] = isBlacklisted_;
        emit AddressBlacklisted(account, isBlacklisted_);
    }
    
    function setExcludedFromLimits(address account, bool excluded) external onlyOwner {
        require(account != address(0), "Cannot exclude zero address");
        isExcludedFromLimits[account] = excluded;
        emit AddressExcluded(account, excluded);
    }
    
    /**
     * @dev إعداد DEX (يجب استدعاؤها بعد إنشاء LP Pair)
     */
    function setupDEX(address pair, address router) external onlyOwner {
        require(pair != address(0), "Invalid pair");
        require(router != address(0), "Invalid router");
        isExcludedFromLimits[pair] = true;
        isExcludedFromLimits[router] = true;
        emit AddressExcluded(pair, true);
        emit AddressExcluded(router, true);
    }
    
    function setMaxWalletAmount(uint256 newAmount) external onlyOwner {
        require(newAmount > 0, "Amount must be greater than 0");
        require(newAmount <= MAX_SUPPLY, "Cannot exceed max supply");
        uint256 oldAmount = maxWalletAmount;
        maxWalletAmount = newAmount;
        emit MaxWalletUpdated(oldAmount, newAmount);
    }
    
    function finishMinting() external onlyOwner {
        mintingFinished = true;
        emit MintingFinished();
    }
    
    function resumeMinting() external onlyOwner {
        require(!mintLockPermanent, "Mint lock is permanent");
        mintingFinished = false;
        emit MintingResumed();
    }
    
    function makeMintLockPermanent() external onlyOwner {
        require(mintingFinished, "Must finish minting first");
        mintLockPermanent = true;
        emit MintLockMadePermanent();
    }
    
    function transferOwnership(address newOwner) public override onlyOwner {
        require(newOwner != address(0), "New owner is zero address");
        super.transferOwnership(newOwner);
        isExcludedFromLimits[newOwner] = true;
        emit AddressExcluded(newOwner, true);
    }
    
    // ═════════════════════════════════════════════════════════════
    // MINT FUNCTIONS
    // ═════════════════════════════════════════════════════════════
    
    function mint(address to, uint256 amount) 
        external 
        onlyOwner 
        whenMintingNotFinished 
        whenNotPaused 
        notBlacklisted(to)
    {
        require(to != address(0), "Cannot mint to zero address");
        require(amount > 0, "Amount must be greater than 0");
        require(totalSupply() + amount <= MAX_SUPPLY, "Exceeds max supply");
        
        _mint(to, amount);
        emit TokensMinted(to, amount);
    }
    
    function mintBatch(
        address[] calldata recipients,
        uint256[] calldata amounts
    ) 
        external 
        onlyOwner 
        whenMintingNotFinished 
        whenNotPaused 
    {
        uint256 len = recipients.length;
        require(len == amounts.length, "Length mismatch");
        require(len > 0, "Empty batch");
        require(len <= MAX_BATCH_SIZE, "Batch too large");
        
        uint256 totalAmount;

        for (uint256 i; i < len; ) {
            address to = recipients[i];
            uint256 amount = amounts[i];
            
            require(to != address(0), "Cannot mint to zero address");
            require(!blacklist[to], "Cannot mint to blacklisted address");
            require(amount > 0, "Amount must be greater than 0");
            
            totalAmount += amount;
            unchecked { ++i; }
        }
        
        require(totalSupply() + totalAmount <= MAX_SUPPLY, "Exceeds max supply");
        
        // ✅ التحقق من maxWallet قبل الـ mint
        for (uint256 i; i < len; ) {
            _checkMaxWalletBefore(recipients[i], amounts[i]);
            unchecked { ++i; }
        }
        
        for (uint256 i; i < len; ) {
            _mint(recipients[i], amounts[i]);
            emit TokensMinted(recipients[i], amounts[i]);
            unchecked { ++i; }
        }
    }
    
    // ═════════════════════════════════════════════════════════════
    // BURN FUNCTIONS
    // ═════════════════════════════════════════════════════════════
    
    function burn(uint256 amount) public override whenNotPaused {
        require(amount > 0, "Amount must be greater than 0");
        super.burn(amount);
        emit TokensBurned(msg.sender, amount);
    }
    
    function burnFrom(address account, uint256 amount) public override whenNotPaused {
        require(amount > 0, "Amount must be greater than 0");
        super.burnFrom(account, amount);
        emit TokensBurned(account, amount);
    }
    
    // ═════════════════════════════════════════════════════════════
    // TRANSFER OVERRIDES
    // ═════════════════════════════════════════════════════════════
    
    function approve(address spender, uint256 value) 
        public 
        override 
        whenNotPaused 
        notBlacklisted(msg.sender) 
        notBlacklisted(spender) 
        returns (bool) 
    {
        return super.approve(spender, value);
    }
    
    function increaseAllowance(address spender, uint256 addedValue) 
        public 
        override 
        whenNotPaused 
        notBlacklisted(msg.sender) 
        notBlacklisted(spender) 
        returns (bool) 
    {
        return super.increaseAllowance(spender, addedValue);
    }
    
    function decreaseAllowance(address spender, uint256 subtractedValue) 
        public 
        override 
        whenNotPaused 
        notBlacklisted(msg.sender) 
        notBlacklisted(spender) 
        returns (bool) 
    {
        return super.decreaseAllowance(spender, subtractedValue);
    }
    
    function transferFrom(address from, address to, uint256 amount) 
        public 
        override 
        whenNotPaused 
        returns (bool) 
    {
        return super.transferFrom(from, to, amount);
    }
    
    // ═════════════════════════════════════════════════════════════
    // INTERNAL FUNCTIONS
    // ═════════════════════════════════════════════════════════════
    
    function _update(
        address from,
        address to,
        uint256 amount
    ) internal override {
        require(!paused(), "Contract is paused");
        
        if (from != address(0)) {
            require(!blacklist[from], "Sender is blacklisted");
        }
        if (to != address(0)) {
            require(!blacklist[to], "Recipient is blacklisted");
        }
        
        if (to != address(0)) {
            _checkMaxWalletBefore(to, amount);
        }
        
        super._update(from, to, amount);
    }
    
    function _checkMaxWalletBefore(address account, uint256 amount) internal view {
        if (!isExcludedFromLimits[account]) {
            require(balanceOf(account) + amount <= maxWalletAmount, "Exceeds max wallet");
        }
    }
}
