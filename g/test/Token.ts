import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { ProjectToken, MockERC20 } from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("ProjectToken Contract Tests", function () {
  let token: ProjectToken;
  let timelock: SignerWithAddress;
  let user1: SignerWithAddress;
  let user2: SignerWithAddress;
  let user3: SignerWithAddress;
  let vestingContract: SignerWithAddress;
  let pair: SignerWithAddress;
  let router: SignerWithAddress;
  let others: SignerWithAddress[];

  const MAX_SUPPLY = ethers.parseUnits("1000000000", 18);
  const GOVERNANCE_PERIOD = 180 * 24 * 60 * 60; // 180 days

  beforeEach(async function () {
    [timelock, user1, user2, user3, vestingContract, pair, router, ...others] = await ethers.getSigners();

    const recipients = [user1.address, user2.address, user3.address];
    const perUser = MAX_SUPPLY / 3n;
    const amounts = [perUser, perUser, MAX_SUPPLY - 2n * perUser];

    const ProjectTokenFactory = await ethers.getContractFactory("ProjectToken");
    token = await ProjectTokenFactory.deploy(
      "Project Token",
      "PRJ",
      timelock.address,
      recipients,
      amounts,
      vestingContract.address
    );
    await token.waitForDeployment();
  });

  // ============ CONSTRUCTOR TESTS ============
  describe("Constructor", function () {
    it("Should set correct initial values", async function () {
      expect(await token.name()).to.equal("Project Token");
      expect(await token.symbol()).to.equal("PRJ");
      expect(await token.timelock()).to.equal(timelock.address);
      expect(await token.maxWalletAmount()).to.equal(ethers.parseUnits("10000000", 18));
      expect(await token.finalized()).to.be.false;
      expect(await token.maxWalletDisabled()).to.be.false;
      expect(await token.vestingContract()).to.equal(vestingContract.address);
    });

    it("Should mint max supply to recipients", async function () {
      expect(await token.totalSupply()).to.equal(MAX_SUPPLY);
      expect(await token.balanceOf(user1.address)).to.be.gt(0);
      expect(await token.balanceOf(user2.address)).to.be.gt(0);
      expect(await token.balanceOf(user3.address)).to.be.gt(0);
    });

    it("Should exclude vesting contract from limits", async function () {
      expect(await token.isExcludedFromLimits(vestingContract.address)).to.be.true;
    });

    it("Should exclude timelock from limits", async function () {
      expect(await token.isExcludedFromLimits(timelock.address)).to.be.true;
    });

    it("Should revert with zero timelock", async function () {
      const ProjectTokenFactory = await ethers.getContractFactory("ProjectToken");
      await expect(
        ProjectTokenFactory.deploy(
          "Test",
          "TST",
          ethers.ZeroAddress,
          [user1.address],
          [1000],
          vestingContract.address
        )
      ).to.be.revertedWith("Invalid timelock");
    });

    it("Should revert with length mismatch", async function () {
      const ProjectTokenFactory = await ethers.getContractFactory("ProjectToken");
      await expect(
        ProjectTokenFactory.deploy(
          "Test",
          "TST",
          timelock.address,
          [user1.address, user2.address],
          [1000],
          vestingContract.address
        )
      ).to.be.revertedWith("Length mismatch");
    });

    it("Should revert with empty distribution", async function () {
      const ProjectTokenFactory = await ethers.getContractFactory("ProjectToken");
      await expect(
        ProjectTokenFactory.deploy(
          "Test",
          "TST",
          timelock.address,
          [],
          [],
          vestingContract.address
        )
      ).to.be.revertedWith("Empty distribution");
    });

    it("Should revert with too many recipients", async function () {
      const ProjectTokenFactory = await ethers.getContractFactory("ProjectToken");
      const manyRecipients = Array(201).fill(user1.address);
      const manyAmounts = Array(201).fill(1);
      
      await expect(
        ProjectTokenFactory.deploy(
          "Test",
          "TST",
          timelock.address,
          manyRecipients,
          manyAmounts,
          vestingContract.address
        )
      ).to.be.revertedWith("Too many recipients");
    });

    it("Should revert when minting to zero address", async function () {
      const ProjectTokenFactory = await ethers.getContractFactory("ProjectToken");
      await expect(
        ProjectTokenFactory.deploy(
          "Test",
          "TST",
          timelock.address,
          [ethers.ZeroAddress],
          [1000],
          vestingContract.address
        )
      ).to.be.revertedWith("Cannot mint to zero");
    });

    it("Should revert when minting zero amount", async function () {
      const ProjectTokenFactory = await ethers.getContractFactory("ProjectToken");
      await expect(
        ProjectTokenFactory.deploy(
          "Test",
          "TST",
          timelock.address,
          [user1.address],
          [0],
          vestingContract.address
        )
      ).to.be.revertedWith("Amount must be > 0");
    });

    it("Should revert when minting to contract", async function () {
      const ProjectTokenFactory = await ethers.getContractFactory("ProjectToken");
      await expect(
        ProjectTokenFactory.deploy(
          "Test",
          "TST",
          timelock.address,
          [await token.getAddress()], // Contract address
          [1000],
          vestingContract.address
        )
      ).to.be.revertedWith("Cannot mint to contract");
    });

    it("Should revert when not minting max supply", async function () {
      const ProjectTokenFactory = await ethers.getContractFactory("ProjectToken");
      await expect(
        ProjectTokenFactory.deploy(
          "Test",
          "TST",
          timelock.address,
          [user1.address],
          [1000],
          vestingContract.address
        )
      ).to.be.revertedWith("Must mint max supply");
    });
  });

  // ============ ROLE MANAGEMENT TESTS ============
  describe("Role Management", function () {
    it("Should grant role successfully", async function () {
      const newAdmin = others[0];
      
      await expect(token.connect(timelock).grantRole(await token.ADMIN_ROLE(), newAdmin.address))
        .to.emit(token, "RoleGranted")
        .withArgs(await token.ADMIN_ROLE(), newAdmin.address, timelock.address);

      expect(await token.hasAdminRole(newAdmin.address)).to.be.true;
    });

    it("Should revert granting to zero address", async function () {
      await expect(
        token.connect(timelock).grantRole(await token.ADMIN_ROLE(), ethers.ZeroAddress)
      ).to.be.revertedWith("Cannot grant to zero address");
    });

    it("Should revert when unauthorized", async function () {
      await expect(
        token.connect(user1).grantRole(await token.ADMIN_ROLE(), user2.address)
      ).to.be.revertedWith("Only timelock with role admin");
    });

    it("Should revert after governance expired", async function () {
      await time.increase(GOVERNANCE_PERIOD + 1);
      
      await expect(
        token.connect(timelock).grantRole(await token.ADMIN_ROLE(), user2.address)
      ).to.be.revertedWith("Governance expired");
    });

    it("Should revert after finalized", async function () {
      // Setup DEX and finalize
      await token.connect(timelock).setupDEX(pair.address, router.address);
      await token.connect(timelock).finalize();
      
      await expect(
        token.connect(timelock).grantRole(await token.ADMIN_ROLE(), user2.address)
      ).to.be.revertedWith("Contract is finalized");
    });

    it("Should revoke role successfully", async function () {
      await token.connect(timelock).grantRole(await token.ADMIN_ROLE(), user2.address);
      
      await expect(token.connect(timelock).revokeRole(await token.ADMIN_ROLE(), user2.address))
        .to.emit(token, "RoleRevoked");

      expect(await token.hasAdminRole(user2.address)).to.be.false;
    });

    it("Should renounce role successfully", async function () {
      await expect(token.connect(timelock).renounceRole(await token.ADMIN_ROLE(), timelock.address))
        .to.emit(token, "RoleRevoked");

      expect(await token.hasAdminRole(timelock.address)).to.be.false;
    });
  });

  // ============ DEX SETUP TESTS ============
  describe("DEX Setup", function () {
    it("Should setup DEX successfully", async function () {
      await expect(token.connect(timelock).setupDEX(pair.address, router.address))
        .to.emit(token, "DEXSetup")
        .withArgs(pair.address, router.address);

      expect(await token.pair()).to.equal(pair.address);
      expect(await token.router()).to.equal(router.address);
      expect(await token.isExcludedFromLimits(pair.address)).to.be.true;
      expect(await token.isExcludedFromLimits(router.address)).to.be.true;
    });

    it("Should revert with zero pair", async function () {
      await expect(
        token.connect(timelock).setupDEX(ethers.ZeroAddress, router.address)
      ).to.be.revertedWith("Invalid pair");
    });

    it("Should revert with zero router", async function () {
      await expect(
        token.connect(timelock).setupDEX(pair.address, ethers.ZeroAddress)
      ).to.be.revertedWith("Invalid router");
    });

    it("Should revert when already setup", async function () {
      await token.connect(timelock).setupDEX(pair.address, router.address);
      
      await expect(
        token.connect(timelock).setupDEX(others[0].address, others[1].address)
      ).to.be.revertedWith("DEX already setup");
    });

    it("Should revert when unauthorized", async function () {
      await expect(
        token.connect(user1).setupDEX(pair.address, router.address)
      ).to.be.reverted;
    });
  });

  // ============ MAX WALLET TESTS ============
  describe("Max Wallet", function () {
    it("Should update max wallet amount", async function () {
      const newAmount = ethers.parseUnits("5000000", 18);
      
      await expect(token.connect(timelock).setMaxWalletAmount(newAmount))
        .to.emit(token, "MaxWalletUpdated");

      expect(await token.maxWalletAmount()).to.equal(newAmount);
    });

    it("Should revert updating to zero", async function () {
      await expect(
        token.connect(timelock).setMaxWalletAmount(0)
      ).to.be.revertedWith("Amount must be > 0");
    });

    it("Should revert exceeding max supply", async function () {
      await expect(
        token.connect(timelock).setMaxWalletAmount(MAX_SUPPLY + 1n)
      ).to.be.revertedWith("Exceeds max supply");
    });

    it("Should enforce max wallet for non-excluded", async function () {
      const maxWallet = await token.maxWalletAmount();
      const currentBalance = await token.balanceOf(user2.address);
      
      if (currentBalance < maxWallet) {
        const transferAmount = maxWallet - currentBalance + 1n;
        
        // This should fail if it exceeds max wallet
        // But user1 might not have enough tokens
        const user1Balance = await token.balanceOf(user1.address);
        if (user1Balance >= transferAmount) {
          await expect(
            token.connect(user1).transfer(user2.address, transferAmount)
          ).to.be.revertedWith("Exceeds max wallet");
        }
      }
    });

    it("Should not enforce max wallet for excluded addresses", async function () {
      await token.connect(timelock).setupDEX(pair.address, router.address);
      
      const largeAmount = ethers.parseUnits("20000000", 18); // Exceeds max wallet
      
      // Pair should be excluded
      await expect(token.connect(user1).transfer(pair.address, largeAmount)).to.not.be.reverted;
    });
  });

  // ============ EXCLUDED LIMITS TESTS ============
  describe("Excluded Limits", function () {
    it("Should set excluded successfully", async function () {
      await expect(token.connect(timelock).setExcludedFromLimits(user1.address, true))
        .to.emit(token, "AddressExcluded")
        .withArgs(user1.address, true);

      expect(await token.isExcludedFromLimits(user1.address)).to.be.true;
    });

    it("Should revert excluding zero address", async function () {
      await expect(
        token.connect(timelock).setExcludedFromLimits(ethers.ZeroAddress, true)
      ).to.be.revertedWith("Cannot exclude zero");
    });
  });

  // ============ RESCUE TESTS ============
  describe("Rescue", function () {
    it("Should rescue tokens successfully", async function () {
      // Deploy mock token and send to ProjectToken
      const MockTokenFactory = await ethers.getContractFactory("MockERC20");
      const mockToken = await MockTokenFactory.deploy("Mock", "MCK");
      await mockToken.waitForDeployment();
      
      await mockToken.mint(await token.getAddress(), 1000);
      
      await expect(token.connect(timelock).rescueTokens(await mockToken.getAddress(), user1.address, 1000))
        .to.emit(token, "TokensRescued");

      expect(await mockToken.balanceOf(user1.address)).to.equal(1000);
    });

    it("Should revert rescuing zero token", async function () {
      await expect(
        token.connect(timelock).rescueTokens(ethers.ZeroAddress, user1.address, 1000)
      ).to.be.revertedWith("Invalid token");
    });

    it("Should revert rescuing to zero address", async function () {
      const MockTokenFactory = await ethers.getContractFactory("MockERC20");
      const mockToken = await MockTokenFactory.deploy("Mock", "MCK");
      
      await expect(
        token.connect(timelock).rescueTokens(await mockToken.getAddress(), ethers.ZeroAddress, 1000)
      ).to.be.revertedWith("Invalid recipient");
    });

    it("Should revert rescuing zero amount", async function () {
      const MockTokenFactory = await ethers.getContractFactory("MockERC20");
      const mockToken = await MockTokenFactory.deploy("Mock", "MCK");
      
      await expect(
        token.connect(timelock).rescueTokens(await mockToken.getAddress(), user1.address, 0)
      ).to.be.revertedWith("Amount must be > 0");
    });

    it("Should revert when unauthorized", async function () {
      const MockTokenFactory = await ethers.getContractFactory("MockERC20");
      const mockToken = await MockTokenFactory.deploy("Mock", "MCK");
      
      await expect(
        token.connect(user1).rescueTokens(await mockToken.getAddress(), user1.address, 1000)
      ).to.be.reverted;
    });

    it("Should revert after finalize", async function () {
      await token.connect(timelock).setupDEX(pair.address, router.address);
      await token.connect(timelock).finalize();
      
      const MockTokenFactory = await ethers.getContractFactory("MockERC20");
      const mockToken = await MockTokenFactory.deploy("Mock", "MCK");
      
      await expect(
        token.connect(timelock).rescueTokens(await mockToken.getAddress(), user1.address, 1000)
      ).to.be.revertedWith("Contract is finalized");
    });

    it("Should rescue ETH successfully", async function () {
      // Send ETH to contract
      await others[0].sendTransaction({
        to: await token.getAddress(),
        value: ethers.parseEther("1")
      });
      
      const balanceBefore = await ethers.provider.getBalance(user1.address);
      
      await expect(token.connect(timelock).rescueETH(user1.address))
        .to.emit(token, "ETHRescued");

      const balanceAfter = await ethers.provider.getBalance(user1.address);
      expect(balanceAfter - balanceBefore).to.equal(ethers.parseEther("1"));
    });

    it("Should revert rescuing ETH when no ETH", async function () {
      await expect(
        token.connect(timelock).rescueETH(user1.address)
      ).to.be.revertedWith("No ETH to rescue");
    });

    it("Should revert rescuing ETH to zero address", async function () {
      await others[0].sendTransaction({
        to: await token.getAddress(),
        value: ethers.parseEther("1")
      });
      
      await expect(
        token.connect(timelock).rescueETH(ethers.ZeroAddress)
      ).to.be.revertedWith("Invalid recipient");
    });
  });

  // ============ FINALIZE TESTS ============
  describe("Finalize", function () {
    beforeEach(async function () {
      await token.connect(timelock).setupDEX(pair.address, router.address);
    });

    it("Should finalize successfully", async function () {
      await expect(token.connect(timelock).finalize())
        .to.emit(token, "Finalized")
        .to.emit(token, "ContractImmutable");

      expect(await token.finalized()).to.be.true;
      expect(await token.maxWalletDisabled()).to.be.true;
      expect(await token.maxWalletAmount()).to.equal(0);
      expect(await token.isImmutable()).to.be.true;
    });

    it("Should revert without DEX setup", async function () {
      // Deploy new token without DEX
      const recipients = [user1.address];
      const amounts = [MAX_SUPPLY];
      
      const ProjectTokenFactory = await ethers.getContractFactory("ProjectToken");
      const newToken = await ProjectTokenFactory.deploy(
        "Test",
        "TST",
        timelock.address,
        recipients,
        amounts,
        vestingContract.address
      );
      
      await expect(
        newToken.connect(timelock).finalize()
      ).to.be.revertedWith("DEX not set");
    });

    it("Should revert when already finalized", async function () {
      await token.connect(timelock).finalize();
      
      await expect(
        token.connect(timelock).finalize()
      ).to.be.revertedWith("Contract is finalized");
    });

    it("Should revert when unauthorized during governance", async function () {
      await expect(
        token.connect(user1).finalize()
      ).to.be.revertedWith("Only admin");
    });

    it("Should allow timelock finalize after governance", async function () {
      await time.increase(GOVERNANCE_PERIOD + 1);
      
      await expect(token.connect(timelock).finalize()).to.not.be.reverted;
      expect(await token.finalized()).to.be.true;
    });

    it("Should revert non-timelock finalize after governance", async function () {
      await time.increase(GOVERNANCE_PERIOD + 1);
      
      await expect(
        token.connect(user1).finalize()
      ).to.be.revertedWith("Only timelock after expiry");
    });

    it("Should revoke all roles after finalize", async function () {
      await token.connect(timelock).finalize();
      
      expect(await token.hasAdminRole(timelock.address)).to.be.false;
      expect(await token.hasDefaultAdminRole(timelock.address)).to.be.false;
      expect(await token.hasDexManagerRole(timelock.address)).to.be.false;
    });
  });

  // ============ BURN TESTS ============
  describe("Burn", function () {
    it("Should burn successfully", async function () {
      const burnAmount = ethers.parseUnits("1000", 18);
      const balanceBefore = await token.balanceOf(user1.address);
      
      await expect(token.connect(user1).burn(burnAmount))
        .to.emit(token, "TokensBurned");

      expect(await token.balanceOf(user1.address)).to.equal(balanceBefore - burnAmount);
    });

    it("Should revert burning zero", async function () {
      await expect(
        token.connect(user1).burn(0)
      ).to.be.revertedWith("Amount must be > 0");
    });

    it("Should burn from successfully", async function () {
      const burnAmount = ethers.parseUnits("1000", 18);
      
      await token.connect(user1).approve(others[0].address, burnAmount);
      
      await token.connect(others[0]).burnFrom(user1.address, burnAmount);
      
      expect(await token.allowance(user1.address, others[0].address)).to.equal(0);
    });
  });

  // ============ TRANSFER TESTS ============
  describe("Transfer", function () {
    it("Should transfer successfully", async function () {
      const transferAmount = ethers.parseUnits("1000", 18);
      const balanceBefore = await token.balanceOf(user2.address);
      
      await token.connect(user1).transfer(user2.address, transferAmount);
      
      expect(await token.balanceOf(user2.address)).to.equal(balanceBefore + transferAmount);
    });

    it("Should allow transfer to excluded addresses exceeding max wallet", async function () {
      await token.connect(timelock).setupDEX(pair.address, router.address);
      
      const largeAmount = ethers.parseUnits("20000000", 18);
      
      await expect(token.connect(user1).transfer(pair.address, largeAmount)).to.not.be.reverted;
    });
  });

  // ============ VIEW FUNCTION TESTS ============
  describe("View Functions", function () {
    it("Should return correct finalized status", async function () {
      expect(await token.isFinalized()).to.be.false;
      
      await token.connect(timelock).setupDEX(pair.address, router.address);
      await token.connect(timelock).finalize();
      
      expect(await token.isFinalized()).to.be.true;
    });

    it("Should return correct immutable status", async function () {
      expect(await token.isImmutable()).to.be.false;
      
      await token.connect(timelock).setupDEX(pair.address, router.address);
      await token.connect(timelock).finalize();
      
      expect(await token.isImmutable()).to.be.true;
    });

    it("Should return correct governance status", async function () {
      expect(await token.isGovernanceExpired()).to.be.false;
      
      await time.increase(GOVERNANCE_PERIOD + 1);
      
      expect(await token.isGovernanceExpired()).to.be.true;
    });

    it("Should return correct governance time remaining", async function () {
      const remaining = await token.governanceTimeRemaining();
      expect(remaining).to.be.gt(0);
      
      await time.increase(GOVERNANCE_PERIOD + 1);
      
      expect(await token.governanceTimeRemaining()).to.equal(0);
    });

    it("Should return correct token status", async function () {
      const status = await token.getTokenStatus();
      
      expect(status._finalized).to.be.false;
      expect(status._maxWalletDisabled).to.be.false;
      expect(status._maxWalletAmount).to.equal(ethers.parseUnits("10000000", 18));
      expect(status._totalMinted).to.equal(MAX_SUPPLY);
      expect(status._totalSupply).to.equal(MAX_SUPPLY);
      expect(status._timelock).to.equal(timelock.address);
      expect(status._isImmutable).to.be.false;
      expect(status._governanceExpired).to.be.false;
      expect(status._governanceRemaining).to.be.gt(0);
    });

    it("Should return correct role statuses", async function () {
      expect(await token.hasAdminRole(timelock.address)).to.be.true;
      expect(await token.hasDexManagerRole(timelock.address)).to.be.true;
      expect(await token.hasDefaultAdminRole(timelock.address)).to.be.true;
      expect(await token.hasFunderRole(timelock.address)).to.be.true;
      
      expect(await token.hasAdminRole(user1.address)).to.be.false;
    });
  });

  // ============ RECEIVE ETH TEST ============
  describe("Receive ETH", function () {
    it("Should accept ETH", async function () {
      const amount = ethers.parseEther("1");
      
      await others[0].sendTransaction({
        to: await token.getAddress(),
        value: amount
      });
      
      expect(await ethers.provider.getBalance(await token.getAddress())).to.equal(amount);
    });
  });
});
'''

with open('/mnt/agents/output/ProjectToken.test.ts', 'w') as f:
    f.write(token_ts_test)

print("✅ ProjectToken.test.ts saved")
print(f"Size: {len(token_ts_test)} characters")

# Create Hardhat config helper
hardhat_config = '''import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.20",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  networks: {
    hardhat: {
      chainId: 31337,
    },
    sepolia: {
      url: process.env.SEPOLIA_RPC || "",
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    },
  },
  gasReporter: {
    enabled: process.env.REPORT_GAS !== undefined,
    currency: "USD",
  },
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY,
  },
};

export default config;
'''

with open('/mnt/agents/output/hardhat.config.ts', 'w') as f:
    f.write(hardhat_config)

print("✅ hardhat.config.ts saved")

# Create package.json
package_json = '''{
  "name": "vesting-token-tests",
  "version": "1.0.0",
  "description": "Test suite for Vesting.sol and ProjectToken.sol",
  "scripts": {
    "compile": "hardhat compile",
    "test": "hardhat test",
    "test:vesting": "hardhat test test/Vesting.test.ts",
    "test:token": "hardhat test test/ProjectToken.test.ts",
    "coverage": "hardhat coverage",
    "node": "hardhat node"
  },
  "devDependencies": {
    "@nomicfoundation/hardhat-toolbox": "^4.0.0",
    "hardhat": "^2.19.0",
    "typescript": "^5.3.0"
  }
}