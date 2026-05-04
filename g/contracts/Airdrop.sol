// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract Airdrop is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ============ ROLES ============
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");

    // ============ IMMUTABLE ============
    IERC20 public immutable token;
    uint64 public immutable deployedAt;

    uint256 public constant GOVERNANCE_PERIOD = 180 days;

    // ============ STATE ============
    bytes32 public merkleRoot;

    bool public initialized;
    bool public finalized;
    bool public permanentlyDisabled;

    uint256 public deadline;
    uint256 public totalClaimed;

    mapping(address => bool) public hasClaimed;

    // ============ EVENTS ============
    event MerkleRootSet(bytes32 root, uint256 deadline);
    event Claimed(address indexed user, uint256 amount, uint256 chainId);
    event Deactivated();
    event Finalized(uint256 timestamp);
    event WithdrawRemaining(address indexed to, uint256 amount);

    // ============ MODIFIERS ============
    modifier onlyActive() {
        require(!finalized, "Finalized");
        require(!permanentlyDisabled, "Disabled");
        _;
    }

    constructor(address _token, address _admin) {
        require(_token != address(0), "Invalid token");
        require(_admin != address(0), "Invalid admin");

        token = IERC20(_token);
        deployedAt = uint64(block.timestamp);

        // 🎯 admin يمكن أن يكون Multi-sig
        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(ADMIN_ROLE, _admin);
        _grantRole(OPERATOR_ROLE, _admin);
    }

    // ============ INIT AIRDROP ============
    function setMerkleRoot(bytes32 _root, uint256 _deadline)
        external
        onlyRole(ADMIN_ROLE)
        onlyActive
    {
        require(!initialized, "Already initialized");
        require(_root != bytes32(0), "Invalid root");
        require(_deadline > block.timestamp + 1 days, "Invalid deadline");

        merkleRoot = _root;
        deadline = _deadline;
        initialized = true;

        emit MerkleRootSet(_root, _deadline);
    }

    // ============ DEACTIVATE ============
    function deactivate()
        external
        onlyRole(ADMIN_ROLE)
        onlyActive
    {
        require(block.timestamp < deadline, "Too late");

        permanentlyDisabled = true;

        uint256 bal = token.balanceOf(address(this));
        if (bal > 0) {
            token.safeTransfer(msg.sender, bal);
        }

        emit Deactivated();
    }

    // ============ CLAIM ============
    function claim(uint256 amount, bytes32[] calldata proof)
        external
        nonReentrant
        onlyActive
    {
        require(initialized, "Not initialized");
        require(block.timestamp <= deadline, "Expired");
        require(!hasClaimed[msg.sender], "Already claimed");

        bytes32 leaf = keccak256(
            abi.encodePacked(msg.sender, amount, block.chainid)
        );

        require(
            MerkleProof.verify(proof, merkleRoot, leaf),
            "Invalid proof"
        );

        hasClaimed[msg.sender] = true;
        totalClaimed += amount;

        token.safeTransfer(msg.sender, amount);

        emit Claimed(msg.sender, amount, block.chainid);
    }

    // ============ WITHDRAW ============
    function withdrawRemaining()
        external
        onlyRole(ADMIN_ROLE)
        nonReentrant
    {
        require(block.timestamp > deadline, "Not ended");

        uint256 bal = token.balanceOf(address(this));
        require(bal > 0, "Nothing left");

        token.safeTransfer(msg.sender, bal);

        finalized = true;

        _lockRoles();

        emit WithdrawRemaining(msg.sender, bal);
        emit Finalized(block.timestamp);
    }

    // ============ FINALIZE ============
    function finalize()
        external
        onlyRole(ADMIN_ROLE)
        onlyActive
    {
        // 🔥 حماية الحوكمة لمدة 180 يوم
        if (block.timestamp < deployedAt + GOVERNANCE_PERIOD) {
            require(
                hasRole(DEFAULT_ADMIN_ROLE, msg.sender),
                "Governance restricted"
            );
        }

        finalized = true;

        _lockRoles();

        emit Finalized(block.timestamp);
    }

    // ============ INTERNAL ============
    function _lockRoles() internal {
        _revokeRole(ADMIN_ROLE, msg.sender);
        _revokeRole(DEFAULT_ADMIN_ROLE, msg.sender);

        _setRoleAdmin(ADMIN_ROLE, bytes32(0));
        _setRoleAdmin(DEFAULT_ADMIN_ROLE, bytes32(0));
    }

    // ============ VIEW ============
    function isFinalized() external view returns (bool) {
        return finalized;
    }

    function isActive() external view returns (bool) {
        return initialized && !finalized && !permanentlyDisabled;
    }

    function hasUserClaimed(address user) external view returns (bool) {
        return hasClaimed[user];
    }

    function getInfo()
        external
        view
        returns (
            bool active,
            bool _finalized,
            uint256 _deadline,
            uint256 remaining,
            uint256 claimed,
            uint256 timeLeft
        )
    {
        active = this.isActive();
        _finalized = finalized;
        _deadline = deadline;
        remaining = token.balanceOf(address(this));
        claimed = totalClaimed;

        timeLeft = block.timestamp >= deadline
            ? 0
            : deadline - block.timestamp;
    }
}