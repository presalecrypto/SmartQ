// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract ProjectToken is ERC20, ERC20Burnable, AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant MAX_SUPPLY = 1_000_000_000 * 10**18;
    uint256 public constant GOVERNANCE_PERIOD = 180 days;

    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant DEX_MANAGER_ROLE = keccak256("DEX_MANAGER_ROLE");
    bytes32 public constant FUNDER_ROLE = keccak256("FUNDER_ROLE");

    address public immutable timelock;
    uint64 public immutable deployedAt;

    bool public finalized;
    bool public maxWalletDisabled;

    uint256 public maxWalletAmount;
    uint256 public totalMinted;

    address public pair;
    address public router;
    address public vestingContract;

    mapping(address => bool) public isExcludedFromLimits;

    event TokensMinted(address indexed to, uint256 amount);
    event AddressExcluded(address indexed account, bool excluded);
    event Finalized();
    event ContractImmutable();

    modifier onlyBeforeFinalize() {
        require(!finalized, "Finalized");
        _;
    }

    constructor(
        string memory name,
        string memory symbol,
        address _timelock,
        address[] memory recipients,
        uint256[] memory amounts,
        address _vestingContract
    ) ERC20(name, symbol) {
        require(_timelock != address(0), "Invalid timelock");
        require(recipients.length == amounts.length, "Mismatch");

        timelock = _timelock;
        deployedAt = uint64(block.timestamp);

        _grantRole(DEFAULT_ADMIN_ROLE, _timelock);
        _grantRole(ADMIN_ROLE, _timelock);
        _grantRole(DEX_MANAGER_ROLE, _timelock);
        _grantRole(FUNDER_ROLE, _timelock);

        // ✅ Vesting support
        if (_vestingContract != address(0)) {
            vestingContract = _vestingContract;

            _grantRole(FUNDER_ROLE, _vestingContract); // 🔥 FIX

            isExcludedFromLimits[_vestingContract] = true;
            emit AddressExcluded(_vestingContract, true);
        }

        for (uint256 i = 0; i < recipients.length; i++) {
            require(recipients[i] != address(0), "Zero address");
            require(recipients[i].code.length == 0, "No contracts");

            totalMinted += amounts[i];
            _mint(recipients[i], amounts[i]);

            emit TokensMinted(recipients[i], amounts[i]);
        }

        require(totalMinted == MAX_SUPPLY, "Invalid supply");

        maxWalletAmount = 10_000_000 * 10**18;

        isExcludedFromLimits[_timelock] = true;
        emit AddressExcluded(_timelock, true);
    }

    function _checkGovernance() internal view {
        require(block.timestamp < deployedAt + GOVERNANCE_PERIOD, "Expired");
    }

    function setupDEX(address _pair, address _router)
        external
        onlyRole(DEX_MANAGER_ROLE)
        onlyBeforeFinalize
    {
        _checkGovernance();

        require(_pair != address(0) && _router != address(0), "Invalid");

        pair = _pair;
        router = _router;

        isExcludedFromLimits[_pair] = true;
        isExcludedFromLimits[_router] = true;

        emit AddressExcluded(_pair, true);
        emit AddressExcluded(_router, true);
    }

    function setExcludedFromLimits(address account, bool excluded)
        external
        onlyRole(ADMIN_ROLE)
        onlyBeforeFinalize
    {
        _checkGovernance();
        isExcludedFromLimits[account] = excluded;
        emit AddressExcluded(account, excluded);
    }

    // ✅ FIXED maxWallet logic
    function _update(address from, address to, uint256 amount) internal override {
        if (!maxWalletDisabled && to != address(0)) {
            if (!isExcludedFromLimits[to]) {
                require(
                    balanceOf(to) + amount <= maxWalletAmount,
                    "Max wallet exceeded"
                );
            }
        }
        super._update(from, to, amount);
    }

    // ✅ SECURE rescue
    function rescueTokens(address tokenAddr, address to, uint256 amount)
        external
        onlyRole(ADMIN_ROLE)
        onlyBeforeFinalize
        nonReentrant
    {
        _checkGovernance();

        require(tokenAddr != address(this), "Cannot rescue own token"); // 🔥 FIX
        require(to != address(0), "Zero address");

        IERC20(tokenAddr).safeTransfer(to, amount);
    }

    function finalize() external onlyBeforeFinalize {
        if (block.timestamp < deployedAt + GOVERNANCE_PERIOD) {
            require(hasRole(ADMIN_ROLE, msg.sender), "Only admin");
        } else {
            require(msg.sender == timelock, "Only timelock");
        }

        require(pair != address(0), "DEX not set");

        finalized = true;
        maxWalletDisabled = true;
        maxWalletAmount = 0;

        _revokeRole(ADMIN_ROLE, timelock);
        _revokeRole(DEX_MANAGER_ROLE, timelock);
        _revokeRole(FUNDER_ROLE, timelock);
        _revokeRole(DEFAULT_ADMIN_ROLE, timelock);

        _setRoleAdmin(ADMIN_ROLE, bytes32(0));
        _setRoleAdmin(DEX_MANAGER_ROLE, bytes32(0));
        _setRoleAdmin(FUNDER_ROLE, bytes32(0));

        emit Finalized();
        emit ContractImmutable();
    }

    receive() external payable {}
}