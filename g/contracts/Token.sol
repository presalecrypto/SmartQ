// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title ProjectToken
 * @notice ERC20 token with vesting integration, max wallet limits, and automatic decentralization
 * @dev 100% compatible with Vesting.sol - uses same governance pattern and SafeERC20
 */
contract ProjectToken is ERC20, ERC20Burnable, AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ============ Constants ============
    uint256 public constant MAX_SUPPLY = 1_000_000_000 * 10**18;
    uint256 public constant MAX_RECIPIENTS = 200;
    uint256 public constant GOVERNANCE_PERIOD = 180 days; // 6 months

    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant DEX_MANAGER_ROLE = keccak256("DEX_MANAGER_ROLE");
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant FUNDER_ROLE = keccak256("FUNDER_ROLE"); // ← Compatible with Vesting.sol

    // ============ Immutable ============
    address public immutable timelock;
    uint64 public immutable deployedAt;

    // ============ State ============
    bool public finalized;
    bool public maxWalletDisabled;

    uint256 public maxWalletAmount;
    uint256 public totalMinted;

    address public pair;
    address public router;
    address public vestingContract; // ← Added for Vesting.sol compatibility

    mapping(address => bool) public isExcludedFromLimits;

    // ============ Events ============
    event TokensMinted(address indexed to, uint256 amount);
    event TokensBurned(address indexed from, uint256 amount);
    event AddressExcluded(address indexed account, bool isExcluded);
    event MaxWalletUpdated(uint256 oldAmount, uint256 newAmount);
    event MaxWalletDisabled();
    event DEXSetup(address indexed pair, address indexed router);
    event Finalized();
    event ContractImmutable();
    event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender); // ← Added
    event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender); // ← Added
    event TimelockSet(address indexed timelock);
    event GovernanceExpired(uint64 expiryTime);
    event TokensRescued(address indexed token, address indexed to, uint256 amount);
    event ETHRescued(address indexed to, uint256 amount); // ← Added
    event VestingContractSet(address indexed vestingContract); // ← Added

    // ============ Modifiers ============
    modifier onlyBeforeFinalize() {
        require(!finalized, "Contract is finalized");
        _;
    }

    // ============ Constructor ============
    constructor(
        string memory name,
        string memory symbol,
        address _timelock,
        address[] memory initialRecipients,
        uint256[] memory initialAmounts,
        address _vestingContract // ← Added for Vesting.sol compatibility
    ) ERC20(name, symbol) {
        require(_timelock != address(0), "Invalid timelock");
        require(initialRecipients.length == initialAmounts.length, "Length mismatch");
        require(initialRecipients.length > 0, "Empty distribution");
        require(initialRecipients.length <= MAX_RECIPIENTS, "Too many recipients");

        timelock = _timelock;
        deployedAt = uint64(block.timestamp);

        emit TimelockSet(_timelock);

        _grantRole(DEFAULT_ADMIN_ROLE, _timelock);
        _grantRole(ADMIN_ROLE, _timelock);
        _grantRole(DEX_MANAGER_ROLE, _timelock);
        _grantRole(FUNDER_ROLE, _timelock); // ← Grant FUNDER_ROLE to timelock for Vesting.sol

        // Set vesting contract and exclude from limits
        if (_vestingContract != address(0)) {
            vestingContract = _vestingContract;
            isExcludedFromLimits[_vestingContract] = true;
            emit AddressExcluded(_vestingContract, true);
            emit VestingContractSet(_vestingContract);
        }

        for (uint256 i = 0; i < initialRecipients.length; i++) {
            address to = initialRecipients[i];
            uint256 amount = initialAmounts[i];

            require(to != address(0), "Cannot mint to zero");
            require(amount > 0, "Amount must be > 0");
            require(to.code.length == 0, "Cannot mint to contract"); // ← Added protection

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

    // ============ Governance Check ============
    function _checkGovernance() internal view {
        if (block.timestamp >= deployedAt + GOVERNANCE_PERIOD) {
            revert("Governance expired");
        }
    }

    // ============ Role Control (Governance expires automatically) ============
    function grantRole(bytes32 role, address account)
        public
        override
        onlyBeforeFinalize
    {
        _checkGovernance();
        require(account != address(0), "Cannot grant to zero address"); // ← Added
        require(
            hasRole(getRoleAdmin(role), msg.sender) && msg.sender == timelock,
            "Only timelock with role admin"
        );
        super.grantRole(role, account);
        emit RoleGranted(role, account, msg.sender); // ← Added
    }

    function revokeRole(bytes32 role, address account)
        public
        override
        onlyBeforeFinalize
    {
        _checkGovernance();
        require(
            hasRole(getRoleAdmin(role), msg.sender) && msg.sender == timelock,
            "Only timelock with role admin"
        );
        super.revokeRole(role, account);
        emit RoleRevoked(role, account, msg.sender); // ← Added
    }

    function renounceRole(bytes32 role, address callerAccount)
        public
        override
        onlyBeforeFinalize
    {
        _checkGovernance();
        require(msg.sender == timelock, "Only timelock can renounce");
        super.renounceRole(role, callerAccount);
        emit RoleRevoked(role, callerAccount, msg.sender); // ← Added
    }

    // ============ DEX Setup ============
    function setupDEX(address _pair, address _router)
        external
        onlyRole(DEX_MANAGER_ROLE)
        onlyBeforeFinalize
    {
        _checkGovernance();

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

    // ============ Max Wallet ============
    function setMaxWalletAmount(uint256 newAmount)
        external
        onlyRole(ADMIN_ROLE)
        onlyBeforeFinalize
    {
        _checkGovernance();
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
        _checkGovernance();
        require(account != address(0), "Cannot exclude zero");
        isExcludedFromLimits[account] = excluded;
        emit AddressExcluded(account, excluded);
    }

    // ============ Emergency Rescue ============
    function rescueTokens(
        address _token,
        address to,
        uint256 amount
    ) external onlyRole(ADMIN_ROLE) onlyBeforeFinalize nonReentrant {
        _checkGovernance();
        require(to != address(0), "Invalid recipient");
        require(amount > 0, "Amount must be > 0");
        require(_token != address(0), "Invalid token"); // ← Added

        // Cannot rescue the token itself if it would break accounting
        if (_token == address(this)) {
            require(
                balanceOf(address(this)) >= amount,
                "Insufficient contract balance"
            );
        }

        IERC20(_token).safeTransfer(to, amount); // ← Fixed: use safeTransfer
        emit TokensRescued(_token, to, amount);
    }

    // ← Added: Rescue ETH
    function rescueETH(address to) external onlyRole(ADMIN_ROLE) onlyBeforeFinalize nonReentrant {
        _checkGovernance();
        require(to != address(0), "Invalid recipient");
        uint256 balance = address(this).balance;
        require(balance > 0, "No ETH to rescue");
        
        (bool success, ) = to.call{value: balance}("");
        require(success, "ETH transfer failed");
        emit ETHRescued(to, balance);
    }

    // ============ Single-Path Finalization ============
    function finalize()
        external
        onlyBeforeFinalize
    {
        // Path 1: Admin finalizes during governance
        if (block.timestamp < deployedAt + GOVERNANCE_PERIOD) {
            require(hasRole(ADMIN_ROLE, msg.sender), "Only admin");
        } else {
            // Path 2: Only timelock can finalize after governance expires
            require(msg.sender == timelock, "Only timelock after expiry"); // ← Fixed
        }

        require(pair != address(0), "DEX not set");
        require(router != address(0), "Router not set");

        finalized = true;
        maxWalletDisabled = true;
        maxWalletAmount = 0;

        emit MaxWalletDisabled();

        // Revoke all roles from timelock
        _revokeRole(DEX_MANAGER_ROLE, timelock);
        _revokeRole(ADMIN_ROLE, timelock);
        _revokeRole(FUNDER_ROLE, timelock); // ← Added
        _revokeRole(DEFAULT_ADMIN_ROLE, timelock);

        emit RoleRevoked(DEX_MANAGER_ROLE, timelock, address(this));
        emit RoleRevoked(ADMIN_ROLE, timelock, address(this));
        emit RoleRevoked(FUNDER_ROLE, timelock, address(this)); // ← Added
        emit RoleRevoked(DEFAULT_ADMIN_ROLE, timelock, address(this));

        // Disable role administration permanently
        _setRoleAdmin(DEFAULT_ADMIN_ROLE, bytes32(0));
        _setRoleAdmin(ADMIN_ROLE, bytes32(0));
        _setRoleAdmin(DEX_MANAGER_ROLE, bytes32(0));
        _setRoleAdmin(MINTER_ROLE, bytes32(0));
        _setRoleAdmin(FUNDER_ROLE, bytes32(0)); // ← Added

        emit Finalized();
        emit ContractImmutable();

        if (block.timestamp >= deployedAt + GOVERNANCE_PERIOD) {
            emit GovernanceExpired(uint64(deployedAt + GOVERNANCE_PERIOD));
        }
    }

    // ============ Burn ============
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

    // ============ ERC20 Override ============
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

    // ============ View Functions ============
    function isFinalized() external view returns (bool) {
        return finalized;
    }

    function isImmutable() external view returns (bool) {
        return finalized
            && maxWalletDisabled
            && getRoleAdmin(ADMIN_ROLE) == bytes32(0)
            && getRoleAdmin(DEX_MANAGER_ROLE) == bytes32(0);
    }

    function isGovernanceExpired() external view returns (bool) {
        return block.timestamp >= deployedAt + GOVERNANCE_PERIOD;
    }

    function governanceTimeRemaining() external view returns (uint256) {
        uint256 expiry = deployedAt + GOVERNANCE_PERIOD;
        if (block.timestamp >= expiry) return 0;
        return expiry - block.timestamp;
    }

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
            bool _isImmutable,
            bool _governanceExpired,
            uint256 _governanceRemaining
        )
    {
        bool govExpired = block.timestamp >= deployedAt + GOVERNANCE_PERIOD;
        uint256 govRemaining = govExpired ? 0 : (deployedAt + GOVERNANCE_PERIOD) - block.timestamp;

        return (
            finalized,
            maxWalletDisabled,
            maxWalletAmount,
            pair,
            router,
            totalMinted,
            totalSupply(),
            timelock,
            this.isImmutable(),
            govExpired,
            govRemaining
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

    function hasFunderRole(address account) external view returns (bool) { // ← Added for Vesting.sol compatibility
        return hasRole(FUNDER_ROLE, account);
    }

    // ============ Receive ETH ============
    receive() external payable {} // ← Added to accept ETH
}
