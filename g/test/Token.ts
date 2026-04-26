import { expect } from "chai";
import hre from "hardhat";

describe("ProjectToken", function () {
  let token: any;
  let owner: any;
  let addr1: any;
  let addr2: any;
  let addr3: any;

  beforeEach(async function () {
    [owner, addr1, addr2, addr3] = await hre.ethers.getSigners();
    
    const Token = await hre.ethers.getContractFactory("ProjectToken");
    token = await Token.deploy("ProjectToken", "PROJ", owner.address);
  });

  // ═════════════════════════════════════════════════════════════
  // DEPLOYMENT
  // ═════════════════════════════════════════════════════════════

  describe("Deployment", function () {
    it("Should set correct name and symbol", async function () {
      expect(await token.name()).to.equal("ProjectToken");
      expect(await token.symbol()).to.equal("PROJ");
    });

    it("Should set owner correctly", async function () {
      expect(await token.owner()).to.equal(owner.address);
    });

    it("Should have 0 initial supply", async function () {
      expect(await token.totalSupply()).to.equal(0);
    });

    it("Should exclude owner from limits", async function () {
      expect(await token.isExcludedFromLimits(owner.address)).to.be.true;
    });

    it("Should return correct contract state", async function () {
      const state = await token.getContractState();
      expect(state.paused_).to.be.false;
      expect(state.mintingFinished_).to.be.false;
      expect(state.mintLockPermanent_).to.be.false;
      expect(state.maxWallet_).to.equal(hre.ethers.parseEther("10000000"));
      expect(state.totalSupply_).to.equal(0);
      expect(state.maxSupply_).to.equal(hre.ethers.parseEther("1000000000"));
    });
  });

  // ═════════════════════════════════════════════════════════════
  // MINT
  // ═════════════════════════════════════════════════════════════

  describe("Mint", function () {
    it("Should mint tokens to address", async function () {
      await token.mint(addr1.address, 1000);
      expect(await token.balanceOf(addr1.address)).to.equal(1000);
    });

    it("Should increase total supply", async function () {
      await token.mint(addr1.address, 1000);
      expect(await token.totalSupply()).to.equal(1000);
    });

    it("Should emit TokensMinted event", async function () {
      await expect(token.mint(addr1.address, 1000))
        .to.emit(token, "TokensMinted")
        .withArgs(addr1.address, 1000);
    });

    it("Should fail if non-owner tries to mint", async function () {
      await expect(
        token.connect(addr1).mint(addr1.address, 1000)
      ).to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount");
    });

    it("Should fail mint to zero address", async function () {
      await expect(
        token.mint("0x0000000000000000000000000000000000000000", 1000)
      ).to.be.revertedWith("Cannot mint to zero address");
    });

    it("Should fail mint zero amount", async function () {
      await expect(
        token.mint(addr1.address, 0)
      ).to.be.revertedWith("Amount must be greater than 0");
    });

    it("Should fail mint to blacklisted address", async function () {
      await token.setBlacklist(addr1.address, true);
      await expect(
        token.mint(addr1.address, 1000)
      ).to.be.revertedWith("Address is blacklisted");
    });

    it("Should fail if exceeds max supply", async function () {
      const maxSupply = await token.MAX_SUPPLY();
      await expect(
        token.mint(addr1.address, maxSupply + 1n)
      ).to.be.revertedWith("Exceeds max supply");
    });

    it("Should fail when paused", async function () {
      await token.pause();
      await expect(
        token.mint(addr1.address, 1000)
      ).to.be.revertedWithCustomError(token, "EnforcedPause");
    });

    it("Should fail when minting finished", async function () {
      await token.finishMinting();
      await expect(
        token.mint(addr1.address, 1000)
      ).to.be.revertedWith("Minting is finished");
    });
  });

  // ═════════════════════════════════════════════════════════════
  // BATCH MINT
  // ═════════════════════════════════════════════════════════════

  describe("Batch Mint", function () {
    it("Should mint batch to multiple addresses", async function () {
      await token.mintBatch([addr1.address, addr2.address], [1000, 2000]);
      expect(await token.balanceOf(addr1.address)).to.equal(1000);
      expect(await token.balanceOf(addr2.address)).to.equal(2000);
    });

    it("Should fail batch mint with zero address", async function () {
      await expect(
        token.mintBatch(
          [addr1.address, "0x0000000000000000000000000000000000000000"],
          [1000, 1000]
        )
      ).to.be.revertedWith("Cannot mint to zero address");
    });

    it("Should fail batch mint with zero amount", async function () {
      await expect(
        token.mintBatch([addr1.address, addr2.address], [1000, 0])
      ).to.be.revertedWith("Amount must be greater than 0");
    });

    it("Should fail batch mint too large", async function () {
      const recipients = Array(51).fill(addr1.address);
      const amounts = Array(51).fill(1000);
      
      await expect(
        token.mintBatch(recipients, amounts)
      ).to.be.revertedWith("Batch too large");
    });

    it("Should fail batch mint length mismatch", async function () {
      await expect(
        token.mintBatch([addr1.address], [1000, 2000])
      ).to.be.revertedWith("Length mismatch");
    });

    it("Should fail batch mint empty", async function () {
      await expect(
        token.mintBatch([], [])
      ).to.be.revertedWith("Empty batch");
    });

    it("Should fail batch mint to blacklisted", async function () {
      await token.setBlacklist(addr2.address, true);
      await expect(
        token.mintBatch([addr1.address, addr2.address], [1000, 1000])
      ).to.be.revertedWith("Cannot mint to blacklisted address");
    });

    it("Should fail batch mint when paused", async function () {
      await token.pause();
      await expect(
        token.mintBatch([addr1.address], [1000])
      ).to.be.revertedWithCustomError(token, "EnforcedPause");
    });

    it("Should fail batch mint when minting finished", async function () {
      await token.finishMinting();
      await expect(
        token.mintBatch([addr1.address], [1000])
      ).to.be.revertedWith("Minting is finished");
    });
  });

  // ═════════════════════════════════════════════════════════════
  // BURN
  // ═════════════════════════════════════════════════════════════

  describe("Burn", function () {
    it("Should burn tokens", async function () {
      await token.mint(addr1.address, 1000);
      await token.connect(addr1).burn(500);
      expect(await token.balanceOf(addr1.address)).to.equal(500);
    });

    it("Should decrease total supply", async function () {
      await token.mint(addr1.address, 1000);
      await token.connect(addr1).burn(500);
      expect(await token.totalSupply()).to.equal(500);
    });

    it("Should emit TokensBurned event", async function () {
      await token.mint(addr1.address, 1000);
      await expect(token.connect(addr1).burn(500))
        .to.emit(token, "TokensBurned")
        .withArgs(addr1.address, 500);
    });

    it("Should fail burn zero amount", async function () {
      await token.mint(addr1.address, 1000);
      await expect(
        token.connect(addr1).burn(0)
      ).to.be.revertedWith("Amount must be greater than 0");
    });

    it("Should fail burn when paused", async function () {
      await token.mint(addr1.address, 1000);
      await token.pause();
      await expect(
        token.connect(addr1).burn(100)
      ).to.be.revertedWith("Contract is paused");
    });

    it("Should fail burnFrom when paused", async function () {
      await token.mint(addr1.address, 1000);
      await token.connect(addr1).approve(owner.address, 500);
      await token.pause();
      await expect(
        token.burnFrom(addr1.address, 100)
      ).to.be.revertedWith("Contract is paused");
    });
  });

  // ═════════════════════════════════════════════════════════════
  // PAUSABLE
  // ═════════════════════════════════════════════════════════════

  describe("Pausable", function () {
    it("Should pause and unpause", async function () {
      await token.pause();
      expect(await token.paused()).to.be.true;
      expect(await token.isPaused()).to.be.true;
      
      await token.unpause();
      expect(await token.paused()).to.be.false;
    });

    it("Should fail transfer when paused", async function () {
      await token.mint(addr1.address, 1000);
      await token.pause();
      
      await expect(
        token.connect(addr1).transfer(addr2.address, 500)
      ).to.be.revertedWith("Contract is paused");
    });

    it("Should fail approve when paused", async function () {
      await token.mint(addr1.address, 1000);
      await token.pause();
      
      await expect(
        token.connect(addr1).approve(addr2.address, 500)
      ).to.be.revertedWithCustomError(token, "EnforcedPause");
    });

    it("Should fail increaseAllowance when paused", async function () {
      await token.mint(addr1.address, 1000);
      await token.pause();
      
      await expect(
        token.connect(addr1).increaseAllowance(addr2.address, 500)
      ).to.be.revertedWithCustomError(token, "EnforcedPause");
    });

    it("Should fail decreaseAllowance when paused", async function () {
      await token.mint(addr1.address, 1000);
      await token.approve(addr2.address, 500);
      await token.pause();
      
      await expect(
        token.decreaseAllowance(addr2.address, 100)
      ).to.be.revertedWithCustomError(token, "EnforcedPause");
    });

    it("Should fail non-owner pause", async function () {
      await expect(
        token.connect(addr1).pause()
      ).to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount");
    });
  });

  // ═════════════════════════════════════════════════════════════
  // BLACKLIST
  // ═════════════════════════════════════════════════════════════

  describe("Blacklist", function () {
    it("Should blacklist address", async function () {
      await token.setBlacklist(addr1.address, true);
      expect(await token.blacklist(addr1.address)).to.be.true;
    });

    it("Should unblacklist address", async function () {
      await token.setBlacklist(addr1.address, true);
      await token.setBlacklist(addr1.address, false);
      expect(await token.blacklist(addr1.address)).to.be.false;
    });

    it("Should emit AddressBlacklisted event", async function () {
      await expect(token.setBlacklist(addr1.address, true))
        .to.emit(token, "AddressBlacklisted")
        .withArgs(addr1.address, true);
    });

    it("Should fail mint to blacklisted", async function () {
      await token.setBlacklist(addr1.address, true);
      await expect(
        token.mint(addr1.address, 1000)
      ).to.be.revertedWith("Address is blacklisted");
    });

    it("Should fail transfer from blacklisted", async function () {
      await token.mint(addr1.address, 1000);
      await token.setBlacklist(addr1.address, true);
      
      await expect(
        token.connect(addr1).transfer(addr2.address, 500)
      ).to.be.revertedWith("Sender is blacklisted");
    });

    it("Should fail transfer to blacklisted", async function () {
      await token.mint(addr1.address, 1000);
      await token.setBlacklist(addr2.address, true);
      
      await expect(
        token.connect(addr1).transfer(addr2.address, 500)
      ).to.be.revertedWith("Recipient is blacklisted");
    });

    it("Should fail approve from blacklisted", async function () {
      await token.setBlacklist(addr1.address, true);
      await expect(
        token.connect(addr1).approve(addr2.address, 500)
      ).to.be.revertedWith("Address is blacklisted");
    });

    it("Should fail approve to blacklisted", async function () {
      await token.mint(addr1.address, 1000);
      await token.setBlacklist(addr2.address, true);
      await expect(
        token.connect(addr1).approve(addr2.address, 500)
      ).to.be.revertedWith("Address is blacklisted");
    });

    it("Should fail blacklist zero address", async function () {
      await expect(
        token.setBlacklist("0x0000000000000000000000000000000000000000", true)
      ).to.be.revertedWith("Cannot blacklist zero address");
    });

    it("Should fail blacklist owner", async function () {
      await expect(
        token.setBlacklist(owner.address, true)
      ).to.be.revertedWith("Cannot blacklist owner");
    });

    it("Should fail non-owner blacklist", async function () {
      await expect(
        token.connect(addr1).setBlacklist(addr2.address, true)
      ).to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount");
    });
  });

  // ═════════════════════════════════════════════════════════════
  // MAX WALLET
  // ═════════════════════════════════════════════════════════════

  describe("Max Wallet", function () {
    it("Should enforce max wallet limit", async function () {
      const maxWallet = await token.maxWalletAmount();
      await expect(
        token.mint(addr1.address, maxWallet + 1n)
      ).to.be.revertedWith("Exceeds max wallet");
    });

    it("Should update max wallet amount", async function () {
      await token.setMaxWalletAmount(1000);
      expect(await token.maxWalletAmount()).to.equal(1000);
    });

    it("Should emit MaxWalletUpdated event", async function () {
      const oldAmount = await token.maxWalletAmount();
      await expect(token.setMaxWalletAmount(1000))
        .to.emit(token, "MaxWalletUpdated")
        .withArgs(oldAmount, 1000);
    });

    it("Should fail non-owner update max wallet", async function () {
      await expect(
        token.connect(addr1).setMaxWalletAmount(1000)
      ).to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount");
    });

    it("Should fail max wallet zero", async function () {
      await expect(
        token.setMaxWalletAmount(0)
      ).to.be.revertedWith("Amount must be greater than 0");
    });

    it("Should exclude from max wallet", async function () {
      await token.setExcludedFromLimits(addr1.address, true);
      const maxWallet = await token.maxWalletAmount();
      await token.mint(addr1.address, maxWallet + 1000n);
      expect(await token.balanceOf(addr1.address)).to.be.gt(maxWallet);
    });

    it("Should fail transfer exceeding max wallet", async function () {
      const maxWallet = await token.maxWalletAmount();
      await token.mint(addr1.address, maxWallet);
      await token.mint(addr2.address, 1000);
      
      await expect(
        token.connect(addr2).transfer(addr1.address, 1)
      ).to.be.revertedWith("Exceeds max wallet");
    });
  });

  // ═════════════════════════════════════════════════════════════
  // EXCLUDED FROM LIMITS
  // ═════════════════════════════════════════════════════════════

  describe("Excluded From Limits", function () {
    it("Should exclude and include addresses", async function () {
      await token.setExcludedFromLimits(addr1.address, true);
      expect(await token.isExcludedFromLimits(addr1.address)).to.be.true;
      
      await token.setExcludedFromLimits(addr1.address, false);
      expect(await token.isExcludedFromLimits(addr1.address)).to.be.false;
    });

    it("Should emit AddressExcluded event", async function () {
      await expect(token.setExcludedFromLimits(addr1.address, true))
        .to.emit(token, "AddressExcluded")
        .withArgs(addr1.address, true);
    });

    it("Should fail non-owner exclude", async function () {
      await expect(
        token.connect(addr1).setExcludedFromLimits(addr2.address, true)
      ).to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount");
    });

    it("Should fail exclude zero address", async function () {
      await expect(
        token.setExcludedFromLimits("0x0000000000000000000000000000000000000000", true)
      ).to.be.revertedWith("Cannot exclude zero address");
    });
  });

  // ═════════════════════════════════════════════════════════════
  // MINT LOCK
  // ═════════════════════════════════════════════════════════════

  describe("Mint Lock", function () {
    it("Should finish minting", async function () {
      await token.finishMinting();
      expect(await token.mintingFinished()).to.be.true;
    });

    it("Should emit MintingFinished event", async function () {
      await expect(token.finishMinting())
        .to.emit(token, "MintingFinished");
    });

    it("Should resume minting", async function () {
      await token.finishMinting();
      await token.resumeMinting();
      expect(await token.mintingFinished()).to.be.false;
    });

    it("Should emit MintingResumed event", async function () {
      await token.finishMinting();
      await expect(token.resumeMinting())
        .to.emit(token, "MintingResumed");
    });

    it("Should fail mint after finished", async function () {
      await token.finishMinting();
      await expect(
        token.mint(addr1.address, 1000)
      ).to.be.revertedWith("Minting is finished");
    });

    it("Should make mint lock permanent", async function () {
      await token.finishMinting();
      await token.makeMintLockPermanent();
      expect(await token.mintLockPermanent()).to.be.true;
    });

    it("Should fail resume after permanent", async function () {
      await token.finishMinting();
      await token.makeMintLockPermanent();
      await expect(
        token.resumeMinting()
      ).to.be.revertedWith("Mint lock is permanent");
    });

    it("Should fail make permanent without finish", async function () {
      await expect(
        token.makeMintLockPermanent()
      ).to.be.revertedWith("Must finish minting first");
    });
  });

  // ═════════════════════════════════════════════════════════════
  // OWNERSHIP TRANSFER
  // ═════════════════════════════════════════════════════════════

  describe("Ownership Transfer", function () {
    it("Should transfer ownership", async function () {
      await token.transferOwnership(addr1.address);
      expect(await token.owner()).to.equal(addr1.address);
    });

    it("Should exclude new owner from limits", async function () {
      await token.transferOwnership(addr1.address);
      expect(await token.isExcludedFromLimits(addr1.address)).to.be.true;
    });

    it("Should fail transfer to zero address", async function () {
      await expect(
        token.transferOwnership("0x0000000000000000000000000000000000000000")
      ).to.be.revertedWith("New owner is zero address");
    });

    it("Should fail non-owner transfer", async function () {
      await expect(
        token.connect(addr1).transferOwnership(addr2.address)
      ).to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount");
    });
  });

  // ═════════════════════════════════════════════════════════════
  // DEX SETUP
  // ═════════════════════════════════════════════════════════════

  describe("DEX Setup", function () {
    it("Should setup DEX addresses", async function () {
      await token.setupDEX(addr1.address, addr2.address);
      expect(await token.isExcludedFromLimits(addr1.address)).to.be.true;
      expect(await token.isExcludedFromLimits(addr2.address)).to.be.true;
    });

    it("Should fail setup DEX with zero address", async function () {
      await expect(
        token.setupDEX("0x0000000000000000000000000000000000000000", addr2.address)
      ).to.be.revertedWith("Invalid pair");
    });

    it("Should fail non-owner setup DEX", async function () {
      await expect(
        token.connect(addr1).setupDEX(addr2.address, addr3.address)
      ).to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount");
    });
  });

  // ═════════════════════════════════════════════════════════════
  // TRANSFER FROM (APPROVAL FLOW)
  // ═════════════════════════════════════════════════════════════

  describe("Transfer From", function () {
    it("Should transferFrom with approval", async function () {
      await token.mint(addr1.address, 1000);
      await token.connect(addr1).approve(addr2.address, 500);
      await token.connect(addr2).transferFrom(addr1.address, addr3.address, 500);
      
      expect(await token.balanceOf(addr3.address)).to.equal(500);
      expect(await token.balanceOf(addr1.address)).to.equal(500);
    });

    it("Should fail transferFrom without approval", async function () {
      await token.mint(addr1.address, 1000);
      await expect(
        token.connect(addr2).transferFrom(addr1.address, addr3.address, 500)
      ).to.be.reverted;
    });

    it("Should fail transferFrom when paused", async function () {
      await token.mint(addr1.address, 1000);
      await token.connect(addr1).approve(addr2.address, 500);
      await token.pause();
      
      await expect(
        token.connect(addr2).transferFrom(addr1.address, addr3.address, 500)
      ).to.be.revertedWith("Contract is paused");
    });
  });
});
