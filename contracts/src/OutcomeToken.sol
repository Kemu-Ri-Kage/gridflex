// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title One side of a GRIDFLEX binary market
/// @notice Only the market that deployed this token can mint or burn it.
contract OutcomeToken is ERC20 {
    address public immutable market;
    uint8 private immutable _outcomeDecimals;

    error UnauthorizedMarket(address caller);
    error ZeroMarket();

    modifier onlyMarket() {
        if (msg.sender != market) revert UnauthorizedMarket(msg.sender);
        _;
    }

    constructor(string memory name_, string memory symbol_, address market_, uint8 decimals_)
        ERC20(name_, symbol_)
    {
        if (market_ == address(0)) revert ZeroMarket();
        market = market_;
        _outcomeDecimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _outcomeDecimals;
    }

    function mint(address to, uint256 amount) external onlyMarket {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external onlyMarket {
        _burn(from, amount);
    }
}
