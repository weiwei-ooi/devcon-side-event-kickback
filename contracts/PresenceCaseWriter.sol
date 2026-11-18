// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title PresenceCaseWriter: Proof of Presence case descriptions
/// @notice Holds the case description template (ERC-1497 metaevidence, whose `fileURI` is the juror policy) fixed at
/// deployment, and writes each Kleros case's own description from it: which event, which wallet, which organiser,
/// which deposit, which contract. It also computes the IPFS path of that exact text (CIDv0, as `ipfs add` does with
/// its default settings, and so Kleros's IPFS upload service), so neither side picks the wording and anyone can
/// publish it. Stateless apart from the template; shared by every event of a deployment.
contract PresenceCaseWriter {
    error BadTemplate();

    /// @notice Values the template can name, between its pieces.
    uint8 public constant SLOT_STAKER = 1; // checksummed, as Etherscan shows it
    uint8 public constant SLOT_STAKER_LOWER = 2; // lower case (Kleros Court matches evidence senders in lower case)
    uint8 public constant SLOT_CONTRACT = 3;
    uint8 public constant SLOT_ORGANISER = 4;
    uint8 public constant SLOT_ORGANISER_LOWER = 5;
    uint8 public constant SLOT_EVENT_NAME = 6;
    uint8 public constant SLOT_EVENT_URL = 7;
    uint8 public constant SLOT_EVENT_START = 8; // "2026-11-04 12:30 UTC"
    uint8 public constant SLOT_EVENT_END = 9;
    uint8 public constant SLOT_DEPOSIT = 10; // "0.01 ETH", or "25 USDC (token 0x...)"
    uint8 public constant SLOT_CHAIN_ID = 11;
    uint8 public constant SLOT_LAST = 11;

    struct Facts {
        address staker;
        address eventContract;
        address organiser;
        string name;
        string url;
        uint64 start;
        uint64 end;
        uint256 depositAmount;
        uint8 decimals;
        string symbol;
        address token;
    }

    /// @dev Contract whose code (after a STOP byte) holds abi.encode(string[] pieces, bytes slots).
    address private immutable _templateStore;

    /// @param pieces, slots The template: pieces[0] + value(slots[0]) + pieces[1] + ... + pieces[n] (see SLOT_*).
    /// It must name the challenged wallet (SLOT_STAKER) at least once.
    constructor(string[] memory pieces, bytes memory slots) {
        require(pieces.length == slots.length + 1, BadTemplate());
        bool namesStaker;
        for (uint256 i; i < slots.length; ++i) {
            uint8 s = uint8(slots[i]);
            require(s >= SLOT_STAKER && s <= SLOT_LAST, BadTemplate());
            if (s == SLOT_STAKER) namesStaker = true;
        }
        require(namesStaker, BadTemplate());
        _templateStore = _storeData(abi.encode(pieces, slots));
    }

    /// @notice The template, as passed at deployment.
    function template() public view returns (string[] memory pieces, bytes memory slots) {
        return abi.decode(_readStore(_templateStore), (string[], bytes));
    }

    /// @notice The case description for these facts, and its IPFS path ("/ipfs/Qm...").
    function write(Facts calldata f) external view returns (string memory text, string memory uri) {
        (string[] memory pieces, bytes memory slots) = template();
        bytes memory out = bytes(pieces[0]);
        for (uint256 i; i < slots.length; ++i) out = bytes.concat(out, _slotValue(uint8(slots[i]), f), bytes(pieces[i + 1]));
        return (string(out), string.concat("/ipfs/", _ipfsPath(out)));
    }

    function _slotValue(uint8 slot, Facts calldata f) private view returns (bytes memory) {
        if (slot == SLOT_STAKER) return _checksummed(f.staker);
        if (slot == SLOT_STAKER_LOWER) return _lowerHex(f.staker);
        if (slot == SLOT_CONTRACT) return _checksummed(f.eventContract);
        if (slot == SLOT_ORGANISER) return _checksummed(f.organiser);
        if (slot == SLOT_ORGANISER_LOWER) return _lowerHex(f.organiser);
        if (slot == SLOT_EVENT_NAME) return bytes(f.name);
        if (slot == SLOT_EVENT_URL) return bytes(f.url).length > 0 ? bytes(f.url) : bytes("(none given)");
        if (slot == SLOT_EVENT_START) return _utc(f.start);
        if (slot == SLOT_EVENT_END) return _utc(f.end);
        if (slot == SLOT_DEPOSIT) {
            bytes memory d = bytes.concat(_decimal(f.depositAmount, f.decimals), " ", bytes(f.symbol));
            if (f.token != address(0)) d = bytes.concat(d, " (token ", _checksummed(f.token), ")");
            return d;
        }
        return _uint(block.chainid); // SLOT_CHAIN_ID
    }

    function _uint(uint256 v) private pure returns (bytes memory out) {
        if (v == 0) return "0";
        uint256 len;
        for (uint256 m = v; m > 0; m /= 10) ++len;
        out = new bytes(len);
        for (; v > 0; v /= 10) out[--len] = bytes1(uint8(48 + (v % 10)));
    }

    function _pad2(uint256 v) private pure returns (bytes memory out) {
        out = new bytes(2);
        out[0] = bytes1(uint8(48 + ((v / 10) % 10)));
        out[1] = bytes1(uint8(48 + (v % 10)));
    }

    /// @dev "YYYY-MM-DD HH:MM UTC" (civil-from-days, Howard Hinnant's algorithm).
    function _utc(uint256 ts) private pure returns (bytes memory) {
        uint256 z = ts / 86400 + 719468;
        uint256 era = z / 146097;
        uint256 doe = z - era * 146097;
        uint256 yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
        uint256 doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        uint256 mp = (5 * doy + 2) / 153;
        uint256 d = doy - (153 * mp + 2) / 5 + 1;
        uint256 m = mp < 10 ? mp + 3 : mp - 9;
        uint256 y = yoe + era * 400 + (m <= 2 ? 1 : 0);
        uint256 secs = ts % 86400;
        return bytes.concat(_uint(y), "-", _pad2(m), "-", _pad2(d), " ", _pad2(secs / 3600), ":", _pad2((secs % 3600) / 60), " UTC");
    }

    /// @dev `amount` with `decimals` decimals, trailing zeros removed ("0.01", "25").
    function _decimal(uint256 amount, uint8 decimals) private pure returns (bytes memory) {
        uint256 unit = 10 ** uint256(decimals);
        bytes memory whole = _uint(amount / unit);
        uint256 frac = amount % unit;
        if (frac == 0) return whole;
        uint256 digits = decimals;
        while (frac % 10 == 0) {
            frac /= 10;
            --digits;
        }
        bytes memory f = _uint(frac);
        bytes memory zeros = new bytes(digits - f.length);
        for (uint256 i; i < zeros.length; ++i) zeros[i] = "0";
        return bytes.concat(whole, ".", zeros, f);
    }

    function _lowerHex(address a) private pure returns (bytes memory out) {
        out = new bytes(42);
        out[0] = "0";
        out[1] = "x";
        uint256 v = uint160(a);
        for (uint256 i = 41; i > 1; --i) {
            uint256 d = v & 15;
            out[i] = bytes1(uint8(d < 10 ? 48 + d : 87 + d));
            v >>= 4;
        }
    }

    /// @dev EIP-55 checksummed address, as Etherscan shows it.
    function _checksummed(address a) private pure returns (bytes memory out) {
        out = _lowerHex(a);
        uint256 hash;
        assembly ("memory-safe") {
            hash := keccak256(add(out, 34), 40)
        }
        for (uint256 i; i < 40; ++i) {
            if (uint8(out[i + 2]) > 57 && (hash >> (255 - 4 * i)) & 1 == 1) out[i + 2] = bytes1(uint8(out[i + 2]) - 32);
        }
    }

    /// @dev CIDv0 of `data` as `ipfs add` (default settings) gives it, for data in one block (a dag-pb node holding a
    /// UnixFS file, sha256, base58 multihash).
    function _ipfsPath(bytes memory data) private pure returns (string memory) {
        bytes memory size = _varint(data.length);
        bytes memory file = bytes.concat(hex"080212", size, data, hex"18", size);
        bytes32 digest = sha256(bytes.concat(hex"0a", _varint(file.length), file));
        bytes memory alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
        uint256 d = uint256(digest);
        uint256 hi = (0x1220 << 16) | (d >> 240);
        uint256 mid = (d >> 120) & ((1 << 120) - 1);
        uint256 lo = d & ((1 << 120) - 1);
        bytes memory out = new bytes(46);
        for (uint256 i = 46; i > 0; --i) {
            uint256 r = hi % 58;
            hi /= 58;
            uint256 t = (r << 120) | mid;
            mid = t / 58;
            t = ((t % 58) << 120) | lo;
            lo = t / 58;
            out[i - 1] = alphabet[t % 58];
        }
        return string(out);
    }

    function _varint(uint256 n) private pure returns (bytes memory out) {
        uint256 len = 1;
        for (uint256 m = n >> 7; m > 0; m >>= 7) ++len;
        out = new bytes(len);
        for (uint256 i; i < len - 1; ++i) {
            out[i] = bytes1(uint8(n & 0x7f) | 0x80);
            n >>= 7;
        }
        out[len - 1] = bytes1(uint8(n));
    }

    /// @dev Keeps `data` as the code of a new contract, after a STOP byte so it can never run.
    function _storeData(bytes memory data) private returns (address store) {
        require(data.length < 24_576, BadTemplate());
        bytes memory init = bytes.concat(hex"61", bytes2(uint16(data.length + 1)), hex"80600a3d393df300", data);
        assembly ("memory-safe") {
            store := create(0, add(init, 32), mload(init))
        }
        require(store != address(0), BadTemplate());
    }

    function _readStore(address store) private view returns (bytes memory data) {
        uint256 size = store.code.length - 1;
        data = new bytes(size);
        assembly ("memory-safe") {
            extcodecopy(store, add(data, 32), 1, size)
        }
    }

}
