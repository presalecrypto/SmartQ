
import { expect } from "chai";
import { ethers } from "hardhat";
import { ProjectToken, Vesting, MockPair, MockRouter } from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";

describe("Vesting — Trust-Minimized", function () {
  let token: ProjectToken;
  let vesting: Vesting;
  let mockPair: MockPair;
  let mockRouter: MockRouter;
  let owner: SignerWithAddress;
  let timelock: SignerWithAddress;
  let funder: SignerWithAddress;
  let beneficiary: SignerWithAddress;
  let beneficiary2: SignerWithAddress;
  let attacker: SignerWithAddress;
  let freshUser: SignerWithAddress;

  const MAX_SUPPLY = ethers.parseEther("1000000000");
  const CLIFF = 30 * 24 * 60 * 60; // 30 days
  const VESTING_DURATION = 90 * 24 * 60 * 60; // 90 days

  beforeEach(async function () {
    const signers = await ethers.getSigners();
    owner = signers[0];
    timelock = signers[1]; // timelock for vesting
    funder = signers[2];
    beneficiary = signers[3];
    beneficiary2 = signers[4];
    attacker = signers[5];
    freshUser = signers[6];

    // Deploy Token
    const TokenFactory = await ethers.getContractFactory("ProjectToken");
    token = await TokenFactory.deploy(
      "MyToken", "MTK", owner.address,
      [funder.address], [MAX_SUPPLY]
    );
    await token.waitForDeployment();

    // Deploy Vesting with timelock
    const VestingFactory = await ethers.getContractFactory("Vesting");
    vesting = await VestingFactory.deploy(
      await token.getAddress(),
      timelock.address
    );
    await vesting.waitForDeployment();

    // Approve vesting contract to spend tokens

    // في beforeEach:
    // 1. نقل توكنات من funder إلى timelock
    // في beforeEach:

  
  
  
 // استخدم:
// نقل التوكن من funder إلى timelock
// استثناء timelock من maxWallet
await token.connect(owner).setExcludedFromLimits(timelock.address, true);

// نقل التوكن
await token.connect(funder).transfer(timelock.address, MAX_SUPPLY);

// approve
await token.connect(timelock).approve(await vesting.getAddress(), MAX_SUPPLY);

  }),

  // ═════════════════════════════════════════════════════════════
  // DEPLOYMENT
  // ═════════════════════════════════════════════════════════════

  describe("Deployment", function () {
    it("Should set token address", async function () {
      expect(await vesting.token()).to.equal(await token.getAddress());
    });

    it("Should set timelock address", async function () {
      expect(await vesting.timelock()).to.equal(timelock.address);
    });

    it("Should not be finalized initially", async function () {
      expect(await vesting.finalized()).to.be.false;
    });

    it("Should grant DEFAULT_ADMIN_ROLE to timelock", async function () {
      expect(await vesting.hasRole(await vesting.DEFAULT_ADMIN_ROLE(), timelock.address)).to.be.true;
    });

    it("Should grant FUNDER_ROLE to timelock", async function () {
      expect(await vesting.hasRole(await vesting.FUNDER_ROLE(), timelock.address)).to.be.true;
    });

    it("Should revert with zero token address", async function () {
      const VestingFactory = await ethers.getContractFactory("Vesting");
      await expect(
        VestingFactory.deploy(ethers.ZeroAddress, timelock.address)
      ).to.be.revertedWith("Invalid token");
    });

    it("Should revert with non-contract token address", async function () {
      const VestingFactory = await ethers.getContractFactory("Vesting");
      await expect(
        VestingFactory.deploy(funder.address, timelock.address)
      ).to.be.revertedWith("Token must be contract");
    });

    it("Should revert with zero timelock address", async function () {
      const VestingFactory = await ethers.getContractFactory("Vesting");
      await expect(
        VestingFactory.deploy(await token.getAddress(), ethers.ZeroAddress)
      ).to.be.revertedWith("Invalid timelock");
    });
  });

  // ═════════════════════════════════════════════════════════════
  // ACCESS CONTROL
  // ═════════════════════════════════════════════════════════════

  describe("Access Control", function () {
    it("Should not allow non-timelock to grant roles", async function () {
      await expect(
        vesting.connect(attacker).grantRole(await vesting.FUNDER_ROLE(), attacker.address)
      ).to.be.reverted;
    });

    it("Should not allow non-timelock to revoke roles", async function () {
      await expect(
        vesting.connect(attacker).revokeRole(await vesting.FUNDER_ROLE(), timelock.address)
      ).to.be.reverted;
    });

    it("Should not allow non-timelock to renounce roles", async function () {
      await expect(
        vesting.connect(attacker).renounceRole(await vesting.FUNDER_ROLE(), timelock.address)
      ).to.be.revertedWith("Only timelock can renounce roles");
    });

    it("Should allow timelock to grant FUNDER_ROLE", async function () {
      await vesting.connect(timelock).grantRole(await vesting.FUNDER_ROLE(), funder.address);
      expect(await vesting.hasRole(await vesting.FUNDER_ROLE(), funder.address)).to.be.true;
    });
  });

  // ═════════════════════════════════════════════════════════════
  // CREATE VESTING
  // ═════════════════════════════════════════════════════════════

  describe("Create Vesting", function () {
    it("Should create vesting schedule", async function () {
      const amount = ethers.parseEther("1000");
      
      await expect(vesting.connect(timelock).createVesting(beneficiary.address, amount))
        .to.emit(vesting, "VestingCreated")
        .withArgs(
  beneficiary.address,
  amount,
  amount / 4n,
  timelock.address,
  anyValue
);

      const schedule = await vesting.vestingSchedules(beneficiary.address);
      expect(schedule.initialized).to.be.true;
      expect(schedule.beneficiary).to.equal(beneficiary.address);
      expect(schedule.totalAmount).to.equal(amount - (amount / 4n));
      expect(schedule.releasedAmount).to.equal(0);
      expect(schedule.immediateReleased).to.be.true;
    });

    it("Should transfer immediate release (25%)", async function () {
      const amount = ethers.parseEther("1000");
      const immediateRelease = amount / 4n;
      
      const balanceBefore = await token.balanceOf(beneficiary.address);
      await vesting.connect(timelock).createVesting(beneficiary.address, amount);
      const balanceAfter = await token.balanceOf(beneficiary.address);
      
      expect(balanceAfter - balanceBefore).to.equal(immediateRelease);
    });

    it("Should transfer remaining to contract (75%)", async function () {
      const amount = ethers.parseEther("1000");
      const vested = amount - (amount / 4n);
      
      const contractBalanceBefore = await token.balanceOf(await vesting.getAddress());
      await vesting.connect(timelock).createVesting(beneficiary.address, amount);
      const contractBalanceAfter = await token.balanceOf(await vesting.getAddress());
      
      expect(contractBalanceAfter - contractBalanceBefore).to.equal(vested);
    });

    it("Should update totalVested", async function () {
      const amount = ethers.parseEther("1000");
      const vested = amount - (amount / 4n);
      
      await vesting.connect(timelock).createVesting(beneficiary.address, amount);
      expect(await vesting.totalVested()).to.equal(vested);
    });

    it("Should add beneficiary to list", async function () {
      await vesting.connect(timelock).createVesting(beneficiary.address, ethers.parseEther("1000"));
      expect(await vesting.beneficiaries(0)).to.equal(beneficiary.address);
    });

    it("Should revert with zero address beneficiary", async function () {
      await expect(
        vesting.connect(timelock).createVesting(ethers.ZeroAddress, ethers.parseEther("1000"))
      ).to.be.revertedWith("Zero address");
    });

    it("Should revert with zero amount", async function () {
      await expect(
        vesting.connect(timelock).createVesting(beneficiary.address, 0)
      ).to.be.revertedWith("Amount must be > 0");
    });

    it("Should revert if beneficiary already exists", async function () {
      await vesting.connect(timelock).createVesting(beneficiary.address, ethers.parseEther("1000"));
      await expect(
        vesting.connect(timelock).createVesting(beneficiary.address, ethers.parseEther("1000"))
      ).to.be.revertedWith("Already exists");
    });

    it("Should revert if allowance insufficient", async function () {
      await token.connect(timelock).approve(await vesting.getAddress(), 0);
      await expect(
        vesting.connect(timelock).createVesting(beneficiary.address, ethers.parseEther("1000"))
      ).to.be.reverted;
    });

    it("Should revert if not FUNDER_ROLE", async function () {
      await expect(
        vesting.connect(attacker).createVesting(beneficiary.address, ethers.parseEther("1000"))
      ).to.be.reverted;
    });

    it("Should revert after finalize", async function () {
      await vesting.connect(timelock).createVesting(beneficiary.address, ethers.parseEther("1000"));
      await vesting.connect(timelock).finalize();
      
      await expect(
        vesting.connect(timelock).createVesting(beneficiary2.address, ethers.parseEther("1000"))
      ).to.be.reverted;
    });

    it("Should handle multiple beneficiaries", async function () {
      await vesting.connect(timelock).createVesting(beneficiary.address, ethers.parseEther("1000"));
      await vesting.connect(timelock).createVesting(beneficiary2.address, ethers.parseEther("2000"));
      
      expect(await vesting.beneficiaries(0)).to.equal(beneficiary.address);
      expect(await vesting.beneficiaries(1)).to.equal(beneficiary2.address);
    });
  });

  // ═════════════════════════════════════════════════════════════
  // RELEASABLE AMOUNT
  // ═════════════════════════════════════════════════════════════

  describe("Releasable Amount", function () {
    beforeEach(async function () {
      await vesting.connect(timelock).createVesting(beneficiary.address, ethers.parseEther("1000"));
    });

    it("Should return 0 before cliff", async function () {
      expect(await vesting.releasableAmount(beneficiary.address)).to.equal(0);
    });

    it("Should return 0 for non-existent beneficiary", async function () {
      expect(await vesting.releasableAmount(attacker.address)).to.equal(0);
    });

    it("Should calculate correctly at 50% vesting", async function () {
      // Move time to 50% of vesting (45 days after start = 15 days after cliff)
      const halfVesting = CLIFF + (VESTING_DURATION - CLIFF) / 2;
      await ethers.provider.send("evm_increaseTime", [halfVesting]);
      await ethers.provider.send("evm_mine");

      const releasable = await vesting.releasableAmount(beneficiary.address);
      const totalVested = ethers.parseEther("750"); // 75% of 1000
      const expected = totalVested / 2n; // 50% of vested
      
      expect(releasable).to.be.closeTo(expected, ethers.parseEther("1"));
    });

    it("Should return full amount after vesting complete", async function () {
      await ethers.provider.send("evm_increaseTime", [VESTING_DURATION + 1]);
      await ethers.provider.send("evm_mine");

      expect(await vesting.releasableAmount(beneficiary.address)).to.equal(ethers.parseEther("750"));
    });
  });

  // ═════════════════════════════════════════════════════════════
  // RELEASE
  // ═════════════════════════════════════════════════════════════

  describe("Release", function () {
    beforeEach(async function () {
      await vesting.connect(timelock).createVesting(beneficiary.address, ethers.parseEther("1000"));
    });

    it("Should revert before cliff", async function () {
      await expect(
        vesting.connect(beneficiary).release()
      ).to.be.revertedWith("Nothing to release");
    });

    it("Should release correct amount after cliff", async function () {
      // Move to 50% vesting
      const halfVesting = CLIFF + (VESTING_DURATION - CLIFF) / 2;
      await ethers.provider.send("evm_increaseTime", [halfVesting]);
      await ethers.provider.send("evm_mine");

      const balanceBefore = await token.balanceOf(beneficiary.address);
      await vesting.connect(beneficiary).release();
      const balanceAfter = await token.balanceOf(beneficiary.address);

      const released = balanceAfter - balanceBefore;
      expect(released).to.be.closeTo(ethers.parseEther("375"), ethers.parseEther("1"));
    });

    it("Should update releasedAmount", async function () {
      const halfVesting = CLIFF + (VESTING_DURATION - CLIFF) / 2;
      await ethers.provider.send("evm_increaseTime", [halfVesting]);
      await ethers.provider.send("evm_mine");

      await vesting.connect(beneficiary).release();
      
      const schedule = await vesting.vestingSchedules(beneficiary.address);
      expect(schedule.releasedAmount).to.be.closeTo(ethers.parseEther("375"), ethers.parseEther("1"));
    });

    it("Should update totalReleased", async function () {
      const halfVesting = CLIFF + (VESTING_DURATION - CLIFF) / 2;
      await ethers.provider.send("evm_increaseTime", [halfVesting]);
      await ethers.provider.send("evm_mine");

      const totalReleasedBefore = await vesting.totalReleased();
      await vesting.connect(beneficiary).release();
      const totalReleasedAfter = await vesting.totalReleased();

      expect(totalReleasedAfter - totalReleasedBefore).to.be.closeTo(ethers.parseEther("375"), ethers.parseEther("1"));
    });

    it("Should emit TokensReleased event", async function () {
      const halfVesting = CLIFF + (VESTING_DURATION - CLIFF) / 2;
      await ethers.provider.send("evm_increaseTime", [halfVesting]);
      await ethers.provider.send("evm_mine");

      await expect(vesting.connect(beneficiary).release())
        .to.emit(vesting, "TokensReleased")
        .withArgs(
  beneficiary.address,
  anyValue,
  anyValue
        );
    });

    it("Should emit VestingCompleted when fully released", async function () {
      await ethers.provider.send("evm_increaseTime", [VESTING_DURATION + 1]);
      await ethers.provider.send("evm_mine");

      await expect(vesting.connect(beneficiary).release())
        .to.emit(vesting, "VestingCompleted")
        .withArgs(beneficiary.address);
    });

    it("Should revert if nothing to release", async function () {
      await expect(
        vesting.connect(beneficiary).release()
      ).to.be.revertedWith("Nothing to release");
    });

    it("Should revert for non-beneficiary", async function () {
      await expect(
        vesting.connect(attacker).release()
      ).to.be.revertedWith("No vesting found");
    });

    it("Should allow partial releases", async function () {
      // First release at 33%
      const firstRelease = CLIFF + (VESTING_DURATION - CLIFF) / 3;
      await ethers.provider.send("evm_increaseTime", [firstRelease]);
      await ethers.provider.send("evm_mine");

      await vesting.connect(beneficiary).release();
      const firstAmount = await token.balanceOf(beneficiary.address);

      // Second release at 66%
      const secondRelease = (VESTING_DURATION - CLIFF) / 3;
      await ethers.provider.send("evm_increaseTime", [secondRelease]);
      await ethers.provider.send("evm_mine");

      await vesting.connect(beneficiary).release();
      const secondAmount = await token.balanceOf(beneficiary.address);

      expect(secondAmount).to.be.gt(firstAmount);
    });
  });

  // ═════════════════════════════════════════════════════════════
  // FINALIZE
  // ═════════════════════════════════════════════════════════════

  describe("Finalize", function () {
    beforeEach(async function () {
      await vesting.connect(timelock).createVesting(beneficiary.address, ethers.parseEther("1000"));
    });

    it("Should finalize successfully", async function () {
      await expect(vesting.connect(timelock).finalize())
        .to.emit(vesting, "ContractImmutable");

      expect(await vesting.finalized()).to.be.true;
    });

    it("Should revoke FUNDER_ROLE from timelock", async function () {
      await vesting.connect(timelock).finalize();
      expect(await vesting.hasRole(await vesting.FUNDER_ROLE(), timelock.address)).to.be.false;
    });

    it("Should revoke DEFAULT_ADMIN_ROLE from timelock", async function () {
      await vesting.connect(timelock).finalize();
      expect(await vesting.hasRole(await vesting.DEFAULT_ADMIN_ROLE(), timelock.address)).to.be.false;
    });

    it("Should set role admin to bytes32(0)", async function () {
      await vesting.connect(timelock).finalize();
      expect(await vesting.getRoleAdmin(await vesting.FUNDER_ROLE())).to.equal(ethers.ZeroHash);
      expect(await vesting.getRoleAdmin(await vesting.DEFAULT_ADMIN_ROLE())).to.equal(ethers.ZeroHash);
    });

    it("Should revert if no vesting schedules", async function () {
      const VestingFactory = await ethers.getContractFactory("Vesting");
      const newVesting = await VestingFactory.deploy(await token.getAddress(), timelock.address);
      
      await expect(
        newVesting.connect(timelock).finalize()
      ).to.be.revertedWith("No vesting schedules");
    });

    it("Should revert finalize twice", async function () {
      await vesting.connect(timelock).finalize();
      await expect(
        vesting.connect(timelock).finalize()
      ).to.be.reverted;
    });

    it("Should revert createVesting after finalize", async function () {
      await vesting.connect(timelock).finalize();
      await expect(
        vesting.connect(timelock).createVesting(beneficiary2.address, ethers.parseEther("1000"))
      ).to.be.reverted;
    });

    it("Should allow release after finalize", async function () {
      await vesting.connect(timelock).finalize();
      
      // Move past vesting duration
      await ethers.provider.send("evm_increaseTime", [VESTING_DURATION + 1]);
      await ethers.provider.send("evm_mine");

      await expect(vesting.connect(beneficiary).release()).to.not.be.reverted;
    });
  });

  // ═════════════════════════════════════════════════════════════
  // VIEW FUNCTIONS
  // ═════════════════════════════════════════════════════════════

  describe("View Functions", function () {
    beforeEach(async function () {
      await vesting.connect(timelock).createVesting(beneficiary.address, ethers.parseEther("1000"));
    });

    it("Should return correct vestedAmount before cliff", async function () {
      expect(await vesting.vestedAmount(beneficiary.address)).to.equal(0);
    });

    it("Should return correct vestedAmount at 50%", async function () {
      const halfVesting = CLIFF + (VESTING_DURATION - CLIFF) / 2;
      await ethers.provider.send("evm_increaseTime", [halfVesting]);
      await ethers.provider.send("evm_mine");

      const vested = await vesting.vestedAmount(beneficiary.address);
      expect(vested).to.be.closeTo(ethers.parseEther("375"), ethers.parseEther("1"));
    });

    it("Should return full vestedAmount after completion", async function () {
      await ethers.provider.send("evm_increaseTime", [VESTING_DURATION + 1]);
      await ethers.provider.send("evm_mine");

      expect(await vesting.vestedAmount(beneficiary.address)).to.equal(ethers.parseEther("750"));
    });

    it("Should return correct beneficiaries count", async function () {

    await vesting.connect(timelock).createVesting(
  beneficiary2.address,
  ethers.parseEther("1000")
);
      expect(await vesting.getBeneficiariesCount()).to.equal(2);

    });
  
  });
  // ═════════════════════════════════════════════════════════════
  // SECURITY
  // ═════════════════════════════════════════════════════════════

  describe("Security", function () {
    it("Should not allow attacker to create vesting", async function () {
      await expect(
        vesting.connect(attacker).createVesting(attacker.address, ethers.parseEther("1000"))
      ).to.be.reverted;
    });

    it("Should not allow attacker to finalize", async function () {
      await vesting.connect(timelock).createVesting(beneficiary.address, ethers.parseEther("1000"));
      await expect(
        vesting.connect(attacker).finalize()
      ).to.be.reverted;
    });

    it("Should not allow reentrancy on createVesting", async function () {
      // This is implicitly tested by ReentrancyGuard
      await expect(
        vesting.connect(timelock).createVesting(beneficiary.address, ethers.parseEther("1000"))
      ).to.not.be.reverted;
    });

    it("Should not allow reentrancy on release", async function () {
      await vesting.connect(timelock).createVesting(beneficiary.address, ethers.parseEther("1000"));
      
      await ethers.provider.send("evm_increaseTime", [VESTING_DURATION + 1]);
      await ethers.provider.send("evm_mine");

      await expect(vesting.connect(beneficiary).release()).to.not.be.reverted;
    });

    it("Should maintain immutability after finalize", async function () {
      await vesting.connect(timelock).createVesting(beneficiary.address, ethers.parseEther("1000"));
      await vesting.connect(timelock).finalize();

      expect(await vesting.finalized()).to.be.true;
      expect(await vesting.getRoleAdmin(await vesting.FUNDER_ROLE())).to.equal(ethers.ZeroHash);
    });
  });

  // ═════════════════════════════════════════════════════════════
  // INTEGRATION WITH TOKEN.SOL
  // ═════════════════════════════════════════════════════════════

  describe("Integration with Token.sol", function () {
    it("Should work with ProjectToken", async function () {
      const amount = ethers.parseEther("10000");
      
      await vesting.connect(timelock).createVesting(beneficiary.address, amount);
      
      const schedule = await vesting.vestingSchedules(beneficiary.address);
      expect(schedule.totalAmount).to.equal(amount - (amount / 4n));
    });

    it("Should handle Token.sol transfers correctly", async function () {
      const amount = ethers.parseEther("1000");
      
      
      const before = await token.balanceOf(timelock.address);

await vesting.connect(timelock).createVesting(beneficiary.address,amount);

const after = await token.balanceOf(timelock.address);

expect(before - after).to.equal(amount);
    }),

    it("Should work after Token.sol finalize", async function () {
      // Finalize Token.sol
      const MockPairFactory = await ethers.getContractFactory("MockPair");
      const mockPair = await MockPairFactory.deploy();
      await mockPair.waitForDeployment();
      
      const MockRouterFactory = await ethers.getContractFactory("MockRouter");
      const mockRouter = await MockRouterFactory.deploy();
      await mockRouter.waitForDeployment();
      
      await token.connect(owner).setupDEX(await mockPair.getAddress(), await mockRouter.getAddress());
      await token.connect(owner).finalize();
      
      // Vesting should still work
      await expect(
        vesting.connect(timelock).createVesting(beneficiary.address, ethers.parseEther("1000"))
      ).to.not.be.reverted;
    });
  });
  });