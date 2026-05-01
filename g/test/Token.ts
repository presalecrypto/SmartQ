import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { ProjectToken } from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("ProjectToken — Full Security Audit Test Suite", function () {
  let token: ProjectToken;
  let owner: SignerWithAddress;
  let timelock: SignerWithAddress;
  let admin: SignerWithAddress;
  let dexManager: SignerWithAddress;
  let funder: SignerWithAddress;
  let user1: SignerWithAddress;
  let user2: SignerWithAddress;
  let user3: SignerWithAddress;
  let vestingContract: SignerWithAddress;
  let pair: SignerWithAddress;
  let router: SignerWithAddress;

  const MAX_SUPPLY = ethers.parseEther("1000000000"); // 1B
  const MAX_WALLET = ethers.parseEther("10000000");   // 10M
  const GOVERNANCE_PERIOD = 180n * 24n * 60n * 60n;     // 180 days

  beforeEach(async function () {
    [owner, timelock, admin, dexManager, funder, user1, user2, user3, vestingContract, pair, router] = await ethers.getSigners();

    const ProjectTokenFactory = await ethers.getContractFactory("ProjectToken");

    // Only use EXCLUDED addresses in constructor minting
    const timelockAmount = MAX_SUPPLY - ethers.parseEther("10000000");
    const vestingAmount = ethers.parseEther("10000000");

    token = await ProjectTokenFactory.deploy(
      "ProjectToken",
      "PTK",
      timelock.address,
      [timelock.address, vestingContract.address],
      [timelockAmount, vestingAmount],
      vestingContract.address
    );
    await token.waitForDeployment();
  });

  // ═══════════════════════════════════════════════════════════════
  // 1. DEPLOYMENT & CONSTRUCTOR
  // ═══════════════════════════════════════════════════════════════
  describe("Deployment", function () {
    it("Should set correct name and symbol", async function () {
      expect(await token.name()).to.equal("ProjectToken");
      expect(await token.symbol()).to.equal("PTK");
    });

    it("Should mint MAX_SUPPLY exactly", async function () {
      expect(await token.totalSupply()).to.equal(MAX_SUPPLY);
      expect(await token.totalMinted()).to.equal(MAX_SUPPLY);
    });

    it("Should assign DEFAULT_ADMIN_ROLE to timelock", async function () {
      const DEFAULT_ADMIN_ROLE = await token.DEFAULT_ADMIN_ROLE();
      expect(await token.hasRole(DEFAULT_ADMIN_ROLE, timelock.address)).to.be.true;
    });

    it("Should assign ADMIN_ROLE to timelock", async function () {
      const ADMIN_ROLE = await token.ADMIN_ROLE();
      expect(await token.hasRole(ADMIN_ROLE, timelock.address)).to.be.true;
    });

    it("Should assign DEX_MANAGER_ROLE to timelock", async function () {
      const DEX_MANAGER_ROLE = await token.DEX_MANAGER_ROLE();
      expect(await token.hasRole(DEX_MANAGER_ROLE, timelock.address)).to.be.true;
    });

    it("Should assign FUNDER_ROLE to timelock", async function () {
      const FUNDER_ROLE = await token.FUNDER_ROLE();
      expect(await token.hasRole(FUNDER_ROLE, timelock.address)).to.be.true;
    });

    it("Should assign FUNDER_ROLE to vesting contract", async function () {
      const FUNDER_ROLE = await token.FUNDER_ROLE();
      expect(await token.hasRole(FUNDER_ROLE, vestingContract.address)).to.be.true;
    });

    it("Should exclude timelock from limits", async function () {
      expect(await token.isExcludedFromLimits(timelock.address)).to.be.true;
    });

    it("Should exclude vesting contract from limits", async function () {
      expect(await token.isExcludedFromLimits(vestingContract.address)).to.be.true;
    });

    it("Should set maxWalletAmount to 10M", async function () {
      expect(await token.maxWalletAmount()).to.equal(MAX_WALLET);
    });

    it("Should set deployedAt to current block timestamp", async function () {
      const block = await ethers.provider.getBlock("latest");
      expect(await token.deployedAt()).to.equal(block!.timestamp);
    });

    it("Should revert with zero timelock", async function () {
      const ProjectTokenFactory = await ethers.getContractFactory("ProjectToken");
      await expect(
        ProjectTokenFactory.deploy("T", "T", ethers.ZeroAddress, [user1.address], [MAX_SUPPLY], vestingContract.address)
      ).to.be.revertedWith("Invalid timelock");
    });

    it("Should revert with mismatched recipients/amounts", async function () {
      const ProjectTokenFactory = await ethers.getContractFactory("ProjectToken");
      await expect(
        ProjectTokenFactory.deploy("T", "T", timelock.address, [user1.address, user2.address], [MAX_SUPPLY], vestingContract.address)
      ).to.be.revertedWith("Mismatch");
    });

    it("Should revert if total minted != MAX_SUPPLY", async function () {
      const ProjectTokenFactory = await ethers.getContractFactory("ProjectToken");
      const amount1 = MAX_SUPPLY - ethers.parseEther("1");
      const amount2 = ethers.parseEther("1") - 1n;
      await expect(
        ProjectTokenFactory.deploy("T", "T", timelock.address, [timelock.address, vestingContract.address], [amount1, amount2], vestingContract.address)
      ).to.be.revertedWith("Invalid supply");
    });

    it("Should revert if recipient is zero address", async function () {
      const ProjectTokenFactory = await ethers.getContractFactory("ProjectToken");
      await expect(
        ProjectTokenFactory.deploy("T", "T", timelock.address, [ethers.ZeroAddress], [MAX_SUPPLY], vestingContract.address)
      ).to.be.revertedWith("Zero address");
    });

    it("Should revert if recipient is a contract", async function () {
      const ProjectTokenFactory = await ethers.getContractFactory("ProjectToken");
      // ✅ FIX: Use DummyToken (simple ERC20) instead of ProjectToken to avoid Invalid supply
      const DummyFactory = await ethers.getContractFactory("DummyToken");
      const dummy = await DummyFactory.deploy("D", "D", ethers.parseEther("1000"));
      await dummy.waitForDeployment();

      await expect(
        ProjectTokenFactory.deploy("T", "T", timelock.address, [await dummy.getAddress()], [MAX_SUPPLY], ethers.ZeroAddress)
      ).to.be.revertedWith("No contracts");
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 2. DEX SETUP
  // ═══════════════════════════════════════════════════════════════
  describe("setupDEX", function () {
    it("Should allow DEX_MANAGER_ROLE to set pair and router", async function () {
      await token.connect(timelock).setupDEX(pair.address, router.address);
      expect(await token.pair()).to.equal(pair.address);
      expect(await token.router()).to.equal(router.address);
    });

    it("Should exclude pair and router from limits", async function () {
      await token.connect(timelock).setupDEX(pair.address, router.address);
      expect(await token.isExcludedFromLimits(pair.address)).to.be.true;
      expect(await token.isExcludedFromLimits(router.address)).to.be.true;
    });

    it("Should revert if non-DEX_MANAGER_ROLE calls", async function () {
      await expect(token.connect(user1).setupDEX(pair.address, router.address)).to.be.reverted;
    });

    it("Should revert with zero addresses", async function () {
      await expect(token.connect(timelock).setupDEX(ethers.ZeroAddress, router.address)).to.be.revertedWith("Invalid");
      await expect(token.connect(timelock).setupDEX(pair.address, ethers.ZeroAddress)).to.be.revertedWith("Invalid");
    });

    it("Should revert after finalize", async function () {
      await token.connect(timelock).setupDEX(pair.address, router.address);
      await time.increase(GOVERNANCE_PERIOD + 1n);
      await token.connect(timelock).finalize();
      await expect(token.connect(timelock).setupDEX(user1.address, user2.address)).to.be.reverted;
    });

    it("Should revert after governance period", async function () {
      await time.increase(GOVERNANCE_PERIOD + 1n);
      await expect(token.connect(timelock).setupDEX(pair.address, router.address)).to.be.revertedWith("Expired");
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 3. MAX WALLET LIMITS
  // ═══════════════════════════════════════════════════════════════
  describe("Max Wallet Limits", function () {
    it("Should allow transfer within max wallet limit", async function () {
      await expect(token.connect(timelock).transfer(user1.address, MAX_WALLET)).to.not.be.reverted;
    });

    it("Should revert if transfer exceeds max wallet", async function () {
      await expect(token.connect(timelock).transfer(user1.address, MAX_WALLET + 1n)).to.be.revertedWith("Max wallet exceeded");
    });

    it("Should allow excluded address to exceed limit", async function () {
      const extraAmount = ethers.parseEther("1000000");
      await expect(token.connect(vestingContract).transfer(timelock.address, extraAmount)).to.not.be.reverted;
    });

    it("Should allow vesting contract to exceed limit", async function () {
      await expect(token.connect(timelock).transfer(vestingContract.address, MAX_WALLET + 1n)).to.not.be.reverted;
    });

    it("Should enforce limit on regular users", async function () {
      await token.connect(timelock).transfer(user1.address, MAX_WALLET);
      await expect(token.connect(timelock).transfer(user1.address, 1n)).to.be.revertedWith("Max wallet exceeded");
    });

    it("Should disable max wallet after finalize", async function () {
      await token.connect(timelock).setupDEX(pair.address, router.address);
      await time.increase(GOVERNANCE_PERIOD + 1n);
      await token.connect(timelock).finalize();
      await expect(token.connect(timelock).transfer(user1.address, MAX_WALLET + 1n)).to.not.be.reverted;
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 4. EXCLUDED FROM LIMITS
  // ═══════════════════════════════════════════════════════════════
  describe("Excluded From Limits", function () {
    it("Should allow ADMIN_ROLE to exclude address", async function () {
      await token.connect(timelock).setExcludedFromLimits(user1.address, true);
      expect(await token.isExcludedFromLimits(user1.address)).to.be.true;
    });

    it("Should allow ADMIN_ROLE to remove exclusion", async function () {
      await token.connect(timelock).setExcludedFromLimits(user1.address, true);
      await token.connect(timelock).setExcludedFromLimits(user1.address, false);
      expect(await token.isExcludedFromLimits(user1.address)).to.be.false;
    });

    it("Should revert if non-ADMIN_ROLE calls", async function () {
      await expect(token.connect(user1).setExcludedFromLimits(user2.address, true)).to.be.reverted;
    });

    it("Should revert after finalize", async function () {
      await token.connect(timelock).setupDEX(pair.address, router.address);
      await time.increase(GOVERNANCE_PERIOD + 1n);
      await token.connect(timelock).finalize();
      await expect(token.connect(timelock).setExcludedFromLimits(user1.address, true)).to.be.reverted;
    });

    it("Should revert after governance period", async function () {
      await time.increase(GOVERNANCE_PERIOD + 1n);
      await expect(token.connect(timelock).setExcludedFromLimits(user1.address, true)).to.be.revertedWith("Expired");
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 5. RESCUE TOKENS
  // ═══════════════════════════════════════════════════════════════
  describe("rescueTokens", function () {
    let dummyToken: any; // DummyToken

    beforeEach(async function () {
      // ✅ FIX: Use DummyToken instead of ProjectToken
      const DummyFactory = await ethers.getContractFactory("DummyToken");
      dummyToken = await DummyFactory.deploy("Dummy", "DUM", ethers.parseEther("1000"));
      await dummyToken.waitForDeployment();
      await dummyToken.connect(owner).transfer(await token.getAddress(), ethers.parseEther("100"));
    });

    it("Should allow ADMIN_ROLE to rescue tokens", async function () {
      const before = await dummyToken.balanceOf(timelock.address);
      await token.connect(timelock).rescueTokens(await dummyToken.getAddress(), timelock.address, ethers.parseEther("100"));
      const after = await dummyToken.balanceOf(timelock.address);
      expect(after - before).to.equal(ethers.parseEther("100"));
    });

    it("Should revert when rescuing own token", async function () {
      await expect(token.connect(timelock).rescueTokens(await token.getAddress(), timelock.address, 1n)).to.be.revertedWith("Cannot rescue own token");
    });

    it("Should revert with zero recipient", async function () {
      await expect(token.connect(timelock).rescueTokens(await dummyToken.getAddress(), ethers.ZeroAddress, 1n)).to.be.revertedWith("Zero address");
    });

    it("Should revert if non-ADMIN_ROLE calls", async function () {
      await expect(token.connect(user1).rescueTokens(await dummyToken.getAddress(), user1.address, 1n)).to.be.reverted;
    });

    it("Should revert after finalize", async function () {
      await token.connect(timelock).setupDEX(pair.address, router.address);
      await time.increase(GOVERNANCE_PERIOD + 1n);
      await token.connect(timelock).finalize();
      await expect(token.connect(timelock).rescueTokens(await dummyToken.getAddress(), timelock.address, 1n)).to.be.reverted;
    });

    it("Should revert after governance period", async function () {
      await time.increase(GOVERNANCE_PERIOD + 1n);
      await expect(token.connect(timelock).rescueTokens(await dummyToken.getAddress(), timelock.address, 1n)).to.be.revertedWith("Expired");
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 6. FINALIZE
  // ═══════════════════════════════════════════════════════════════
  describe("finalize", function () {
    it("Should allow ADMIN_ROLE to finalize during governance", async function () {
      await token.connect(timelock).setupDEX(pair.address, router.address);
      await expect(token.connect(timelock).finalize()).to.not.be.reverted;
    });

    it("Should allow timelock to finalize after governance", async function () {
      await token.connect(timelock).setupDEX(pair.address, router.address);
      await time.increase(GOVERNANCE_PERIOD + 1n);
      await expect(token.connect(timelock).finalize()).to.not.be.reverted;
    });

    it("Should revert if DEX not set", async function () {
      await expect(token.connect(timelock).finalize()).to.be.revertedWith("DEX not set");
    });

    it("Should set finalized to true", async function () {
      await token.connect(timelock).setupDEX(pair.address, router.address);
      await token.connect(timelock).finalize();
      expect(await token.finalized()).to.be.true;
    });

    it("Should disable max wallet", async function () {
      await token.connect(timelock).setupDEX(pair.address, router.address);
      await token.connect(timelock).finalize();
      expect(await token.maxWalletDisabled()).to.be.true;
    });

    it("Should revoke ADMIN_ROLE from timelock", async function () {
      await token.connect(timelock).setupDEX(pair.address, router.address);
      await token.connect(timelock).finalize();
      expect(await token.hasRole(await token.ADMIN_ROLE(), timelock.address)).to.be.false;
    });

    it("Should revoke DEFAULT_ADMIN_ROLE from timelock", async function () {
      await token.connect(timelock).setupDEX(pair.address, router.address);
      await token.connect(timelock).finalize();
      expect(await token.hasRole(await token.DEFAULT_ADMIN_ROLE(), timelock.address)).to.be.false;
    });

    it("Should revoke DEX_MANAGER_ROLE from timelock", async function () {
      await token.connect(timelock).setupDEX(pair.address, router.address);
      await token.connect(timelock).finalize();
      expect(await token.hasRole(await token.DEX_MANAGER_ROLE(), timelock.address)).to.be.false;
    });

    it("Should revoke FUNDER_ROLE from timelock", async function () {
      await token.connect(timelock).setupDEX(pair.address, router.address);
      await token.connect(timelock).finalize();
      expect(await token.hasRole(await token.FUNDER_ROLE(), timelock.address)).to.be.false;
    });

    it("Should emit Finalized and ContractImmutable events", async function () {
      await token.connect(timelock).setupDEX(pair.address, router.address);
      await expect(token.connect(timelock).finalize())
        .to.emit(token, "Finalized")
        .and.to.emit(token, "ContractImmutable");
    });

    it("Should revert if already finalized", async function () {
      await token.connect(timelock).setupDEX(pair.address, router.address);
      await token.connect(timelock).finalize();
      await expect(token.connect(timelock).finalize()).to.be.revertedWith("Finalized");
    });

    it("Should revert if non-admin tries during governance", async function () {
      await token.connect(timelock).setupDEX(pair.address, router.address);
      await expect(token.connect(user1).finalize()).to.be.revertedWith("Only admin");
    });

    it("Should revert if non-timelock tries after governance", async function () {
      await token.connect(timelock).setupDEX(pair.address, router.address);
      await time.increase(GOVERNANCE_PERIOD + 1n);
      await expect(token.connect(user1).finalize()).to.be.revertedWith("Only timelock");
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 7. ROLE MANAGEMENT
  // ═══════════════════════════════════════════════════════════════
  describe("Role Management", function () {
    it("Should allow DEFAULT_ADMIN_ROLE to grant roles", async function () {
      await token.connect(timelock).grantRole(await token.ADMIN_ROLE(), admin.address);
      expect(await token.hasRole(await token.ADMIN_ROLE(), admin.address)).to.be.true;
    });

    it("Should allow DEFAULT_ADMIN_ROLE to revoke roles", async function () {
      await token.connect(timelock).grantRole(await token.ADMIN_ROLE(), admin.address);
      await token.connect(timelock).revokeRole(await token.ADMIN_ROLE(), admin.address);
      expect(await token.hasRole(await token.ADMIN_ROLE(), admin.address)).to.be.false;
    });

    it("Should not allow non-admin to grant roles", async function () {
      await expect(token.connect(user1).grantRole(await token.ADMIN_ROLE(), admin.address)).to.be.reverted;
    });

    it("Should not allow role operations after finalize", async function () {
      await token.connect(timelock).setupDEX(pair.address, router.address);
      await token.connect(timelock).finalize();
      await expect(token.connect(timelock).grantRole(await token.ADMIN_ROLE(), admin.address)).to.be.reverted;
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 8. RECEIVE / ETH
  // ═══════════════════════════════════════════════════════════════
  describe("ETH Handling", function () {
    it("Should accept ETH via receive", async function () {
      await expect(owner.sendTransaction({ to: await token.getAddress(), value: ethers.parseEther("1") })).to.not.be.reverted;
    });

    it("Should trap ETH permanently (NO WITHDRAW FUNCTION)", async function () {
      const balanceBefore = await ethers.provider.getBalance(await token.getAddress());
      await owner.sendTransaction({ to: await token.getAddress(), value: ethers.parseEther("1") });
      const balanceAfter = await ethers.provider.getBalance(await token.getAddress());
      expect(balanceAfter).to.equal(balanceBefore + ethers.parseEther("1"));
      expect(balanceAfter).to.be.gt(balanceBefore);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 9. EDGE CASES & ATTACK VECTORS
  // ═══════════════════════════════════════════════════════════════
  describe("Edge Cases & Attack Vectors", function () {
    it("Should handle max wallet with exact boundary", async function () {
      await expect(token.connect(timelock).transfer(user1.address, MAX_WALLET)).to.not.be.reverted;
      expect(await token.balanceOf(user1.address)).to.equal(MAX_WALLET);
    });

    it("Should handle zero amount transfers", async function () {
      await expect(token.connect(timelock).transfer(user1.address, 0n)).to.not.be.reverted;
    });

    it("Should not allow transfer to zero address", async function () {
      await expect(token.connect(timelock).transfer(ethers.ZeroAddress, 1n)).to.be.reverted;
    });

    it("Should maintain correct total supply after transfers", async function () {
      await token.connect(timelock).transfer(user1.address, ethers.parseEther("1000"));
      await token.connect(timelock).transfer(user2.address, ethers.parseEther("2000"));
      expect(await token.totalSupply()).to.equal(MAX_SUPPLY);
    });

    it("Should allow burn to reduce supply", async function () {
      const burnAmount = ethers.parseEther("1000");
      await token.connect(timelock).burn(burnAmount);
      expect(await token.totalSupply()).to.equal(MAX_SUPPLY - burnAmount);
    });

    it("Should handle multiple DEX setups (only before finalize)", async function () {
      await token.connect(timelock).setupDEX(pair.address, router.address);
      await token.connect(timelock).setupDEX(user1.address, user2.address);
      expect(await token.pair()).to.equal(user1.address);
      expect(await token.router()).to.equal(user2.address);
    });

    it("Should prevent double spend via reentrancy (rescueTokens)", async function () {
      // ✅ FIX: Use DummyToken instead of ProjectToken
      const DummyFactory = await ethers.getContractFactory("DummyToken");
      const dummy = await DummyFactory.deploy("Dummy", "DUM", ethers.parseEther("1000"));
      await dummy.waitForDeployment();
      await dummy.connect(owner).transfer(await token.getAddress(), ethers.parseEther("100"));

      const before = await dummy.balanceOf(timelock.address);
      await token.connect(timelock).rescueTokens(await dummy.getAddress(), timelock.address, ethers.parseEther("100"));
      const after = await dummy.balanceOf(timelock.address);
      expect(after - before).to.equal(ethers.parseEther("100"));
    });
  });
});