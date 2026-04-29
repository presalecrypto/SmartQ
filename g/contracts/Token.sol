// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ✅ OpenZeppelin v5 imports (نفس المسارات لكن تأكد أنك مثبت v5)
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";

contract ProjectToken is ERC20, ERC20Burnable, AccessControl {
    
    uint256 public constant MAX_SUPPLY = 1_000_000_000 * 10**18;
    uint256 public constant MAX_RECIPIENTS = 200;

    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant DEX_MANAGER_ROLE = keccak256("DEX_MANAGER_ROLE");

    address public immutable timelock;

    bool public finalized;
    bool public maxWalletDisabled;

    uint256 public maxWalletAmount;

    address public pair;
    address public router;

    uint256 public totalMinted;

    mapping(address => bool) public isExcludedFromLimits;

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

    modifier onlyBeforeFinalize() {
        require(!finalized, "Contract is finalized");
        _;
    }

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

        timelock = _timelock;
        emit TimelockSet(_timelock);

        _grantRole(DEFAULT_ADMIN_ROLE, _timelock);
        _grantRole(ADMIN_ROLE, _timelock);
        _grantRole(DEX_MANAGER_ROLE, _timelock);

        for (uint256 i = 0; i < initialRecipients.length; i++) {
            address to = initialRecipients[i];
            uint256 amount = initialAmounts[i];

            require(to != address(0), "Cannot mint to zero");
            require(amount > 0, "Amount must be > 0");

            totalMinted += amount;

            _mint(to, amount);
            emit TokensMinted(to, amount);
        }

        require(totalMinted == MAX_SUPPLY, "Must mint max supply");
        require(totalMinted > 0, "No tokens minted");

        maxWalletAmount = 10_000_000 * 10**18;

        isExcludedFromLimits[_timelock] = true;
        emit AddressExcluded(_timelock, true);
    }

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

    function setExcludedFromLimits(address account, bool excluded) 
        external 
        onlyRole(ADMIN_ROLE) 
        onlyBeforeFinalize 
    {
        require(account != address(0), "Cannot exclude zero");
        isExcludedFromLimits[account] = excluded;
        emit AddressExcluded(account, excluded);
    }

    function finalize() 
        external 
        onlyRole(ADMIN_ROLE) 
        onlyBeforeFinalize 
    {
        require(pair != address(0), "DEX not set");
        require(router != address(0), "Router not set");

        finalized = true;

        maxWalletDisabled = true;
        maxWalletAmount = 0;
        emit MaxWalletDisabled();

        _revokeRole(DEX_MANAGER_ROLE, timelock);
        _revokeRole(ADMIN_ROLE, timelock);
        _revokeRole(DEFAULT_ADMIN_ROLE, timelock);

        emit RoleRevoked(DEX_MANAGER_ROLE, timelock);
        emit RoleRevoked(ADMIN_ROLE, timelock);
        emit RoleRevoked(DEFAULT_ADMIN_ROLE, timelock);

        _setRoleAdmin(DEFAULT_ADMIN_ROLE, bytes32(0));
        _setRoleAdmin(ADMIN_ROLE, bytes32(0));
        _setRoleAdmin(DEX_MANAGER_ROLE, bytes32(0));

        emit Finalized();
        emit ContractImmutable();
    }

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

    function approve(address spender, uint256 amount)
        public
        override
        returns (bool)
    {
        return super.approve(spender, amount);
    }

    function _update(address from, address to, uint256 amount) internal override {
        if (to != address(0) && !maxWalletDisabled) {
            _checkMaxWalletBefore(to, amount);
        }

        super._update(from, to, amount);
    }

    function _checkMaxWalletBefore(address account, uint256 amount) internal view {
        if (pair != address(0) && account == pair) return;

        if (maxWalletAmount > 0 && !isExcludedFromLimits[account]) {
            require(balanceOf(account) + amount <= maxWalletAmount, "Exceeds max wallet");
        }
    }

    function isFinalized() external view returns (bool) {
        return finalized;
    }

    function isImmutable() external view returns (bool) {
        return finalized 
            && maxWalletDisabled 
            && getRoleAdmin(ADMIN_ROLE) == bytes32(0)
            && getRoleAdmin(DEX_MANAGER_ROLE) == bytes32(0);
    }

    function getTokenStatus() 
        external 
        view 
        returns (
            bool,
            bool,
            uint256,
            address,
            address,
            uint256,
            uint256,
            address,
            bool
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