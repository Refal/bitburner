/** @param {NS} ns **/
export async function main(ns) {
    const filename = ns.args[0] || "contract.cct";
    const host = ns.args[1] || "home";

    const type = ns.codingcontract.getContractType(filename, host);
    const data = ns.codingcontract.getData(filename, host);
    let answer;
    ns.tprint(`type: ${type}, input: ${data}, data type:${(typeof data)}`)
    try {
        switch (type) {
            case "HammingCodes: Encoded Binary to Integer":
                answer = hammingDecode(data);
                break;
            case "HammingCodes: Integer to Encoded Binary":
                answer = hammingEncode(data);
                break;
            case "Total Ways to Sum":
                answer = totalWaysToSum(data);
                break;
            case "Compression II: LZ Decompression":
                answer = lzDecompress(data);
                break;
            case "Compression I: RLE Compression":
                answer = rleCompress(data);
                break;
            case "Compression III: LZ Compression":
              answer = compressionIII(data);
              break;
            case "Unique Paths in a Grid I":
                answer = uniquePaths(data[0], data[1]);
                break;
            case "Merge Overlapping Intervals":
                answer = mergeIntervals(data);
                break;
            case "Proper 2-Coloring of a Graph":
                answer = twoColorGraph(data);
                break;
            case "Array Jumping Game II":
                answer = minJumpsToEnd(data);
                break;
            case "Sanitize Parentheses in Expression":
                answer = sanitizeParentheses(data);
                break;
            case "Array Jumping Game": {
                // Determine format: some contracts expect "true"/"false", others expect 1/0
                const format = ns.codingcontract.getDescription(filename, host);
                if (format.includes("1 or 0")) {
                    answer = canJump(data) ? 1 : 0;
                } else {
                    answer = canJump(data) ? "true" : "false";
                }
                break;
            }
            case "Shortest Path in a Grid":
              answer = shortestPathInGrid(data);
              break;
            case "Unique Paths in a Grid II":
              answer = uniquePathsWithObstacles(data);
              break;
            case "Algorithmic Stock Trader I":
              answer = maxProfitOneTransaction(data);
              break;
            case "Algorithmic Stock Trader II":
              answer = maxProfitUnlimitedTransactions(data);
              break;
            case "Algorithmic Stock Trader III":
              answer = maxProfitTwoTransactions(data);
              break;
            case "Algorithmic Stock Trader IV":
              answer = maxProfitKTransactions(data[0], data[1]);
              break;
            case "Subarray with Maximum Sum":
              answer = maxSubarraySum(data);
              break;
            case "Spiralize Matrix":
              answer = spiralOrder(data);
              break;
            case "Find All Valid Math Expressions":
              answer = findMathExpressions(data[0], data[1]);
              break;
            case "Square Root":
              answer = bigIntSqrt(data);
              break;
            case "Generate IP Addresses":
              answer = generateIPAddresses(data);
              break;
            case "Encryption II: Vigenère Cipher":
              answer = vigenereEncrypt(data[0], data[1]);
              break;
            case "Minimum Path Sum in a Triangle":
              answer = minimumTrianglePathSum(data);
              break;
            case "Total Ways to Sum II":
              answer = totalWaysToSumII(data[0], data[1]);
              break;
            case "Find Largest Prime Factor":
              answer = largestPrimeFactor(data);
              break;
            case "Encryption I: Caesar Cipher":
              answer = caesarEncrypt(data[0], data[1]);
              break;
            default:
                ns.tprint(`❌ Unsupported contract type: ${type}`);
                return;
        }

        const reward = ns.codingcontract.attempt(answer, filename, host, { returnReward: true });
        if (reward) {
            ns.tprint(`✅ Solved: ${type}`);
            ns.tprint(`🎁 Reward: ${reward}`);
        } else {
            ns.tprint(`❌ Incorrect answer: ${answer}`);
        }
    } catch (err) {
        ns.tprint(`💥 Error solving contract: ${err}`);
    }
}

function hammingDecode(encoded) {
    const bits = encoded.split('').map(Number);
    const n = bits.length;

    function isPowerOfTwo(x) {
        return (x & (x - 1)) === 0 && x !== 0;
    }

    // Step 1: Detect error using parity bits at powers of 2 (excluding position 0 at first)
    let errorIndex = 0;
    for (let p = 1; p < n; p <<= 1) {
        let parity = 0;
        for (let i = p; i < n; i += 2 * p) {
            for (let j = i; j < i + p && j < n; j++) {
                parity ^= bits[j];
            }
        }
        if (parity !== bits[p]) {
            errorIndex += p;
        }
    }

    // Step 2: Overall parity at position 0
    const totalOnes = bits.reduce((sum, b) => sum + b, 0);
    if (totalOnes % 2 !== 0 && errorIndex === 0) {
        errorIndex = 0; // Overall parity is the incorrect bit
    }

    // Step 3: Flip the erroneous bit
    if (errorIndex >= 0 && errorIndex < n) {
        bits[errorIndex] ^= 1;
    }

    // Step 4: Extract data bits (exclude all power-of-two positions and index 0)
    const dataBits = [];
    for (let i = 1; i < n; i++) {
        if (!isPowerOfTwo(i)) {
            dataBits.push(bits[i]);
        }
    }

    // Step 5: Convert to decimal (MSB first)
    return parseInt(dataBits.join(''), 2);
}

function totalWaysToSum(n) {
    const dp = Array(n + 1).fill(0);
    dp[0] = 1;
    for (let num = 1; num < n; num++) {
        for (let i = num; i <= n; i++) {
            dp[i] += dp[i - num];
        }
    }
    return dp[n];
}

function lzDecompress(data) {
    let i = 0;
    let result = '';
    let isType1 = true;

    while (i < data.length) {
        const L = parseInt(data[i++]);
        if (L === 0) {
            isType1 = !isType1;
            continue;
        }
        if (isType1) {
            result += data.slice(i, i + L);
            i += L;
        } else {
            const X = parseInt(data[i++]);
            for (let j = 0; j < L; j++) {
                result += result[result.length - X];
            }
        }
        isType1 = !isType1;
    }
    return result;
}

function uniquePaths(m, n) {
    const dp = Array(m).fill(1);
    for (let i = 1; i < n; i++) {
        for (let j = 1; j < m; j++) {
            dp[j] += dp[j - 1];
        }
    }
    return dp[m - 1];
}

function mergeIntervals(intervals) {
    intervals.sort((a, b) => a[0] - b[0]);
    const merged = [intervals[0]];
    for (let i = 1; i < intervals.length; i++) {
        const last = merged[merged.length - 1];
        if (intervals[i][0] <= last[1]) {
            last[1] = Math.max(last[1], intervals[i][1]);
        } else {
            merged.push(intervals[i]);
        }
    }
    return merged;
}

function twoColorGraph([n, edges]) {
    const graph = Array.from({ length: n }, () => []);
    edges.forEach(([u, v]) => {
        graph[u].push(v);
        graph[v].push(u);
    });

    const colors = Array(n).fill(-1);
    for (let start = 0; start < n; start++) {
        if (colors[start] !== -1) continue;
        const queue = [start];
        colors[start] = 0;
        while (queue.length) {
            const u = queue.shift();
            for (const v of graph[u]) {
                if (colors[v] === -1) {
                    colors[v] = 1 - colors[u];
                    queue.push(v);
                } else if (colors[v] === colors[u]) {
                    return [];
                }
            }
        }
    }
    return colors;
}

function isPowerOfTwo(x) {
    return x === 0 ? true : (x & (x - 1)) === 0;
}

function canJump(arr) {
    let maxReach = 0;
    for (let i = 0; i < arr.length; i++) {
        if (i > maxReach) return false;
        maxReach = Math.max(maxReach, i + arr[i]);
    }
    return true;
}

function shortestPathInGrid(grid) {
    const numRows = grid.length;
    const numCols = grid[0].length;
    const directions = [
        [-1, 0, 'U'],
        [1, 0, 'D'],
        [0, -1, 'L'],
        [0, 1, 'R']
    ];

    const visited = Array.from({ length: numRows }, () => Array(numCols).fill(false));
    const queue = [[0, 0, ""]];

    visited[0][0] = true;

    while (queue.length > 0) {
        const [r, c, path] = queue.shift();

        if (r === numRows - 1 && c === numCols - 1) {
            return path;
        }

        for (const [dr, dc, move] of directions) {
            const nr = r + dr;
            const nc = c + dc;
            if (
                nr >= 0 && nr < numRows &&
                nc >= 0 && nc < numCols &&
                grid[nr][nc] === 0 &&
                !visited[nr][nc]
            ) {
                visited[nr][nc] = true;
                queue.push([nr, nc, path + move]);
            }
        }
    }

    // No path found
    return "";
}

function maxProfitOneTransaction(prices) {
    let minPrice = prices[0];
    let maxProfit = 0;

    for (let i = 1; i < prices.length; i++) {
        minPrice = Math.min(minPrice, prices[i]);
        maxProfit = Math.max(maxProfit, prices[i] - minPrice);
    }

    return maxProfit;
}

function maxProfitUnlimitedTransactions(prices) {
    let profit = 0;
    for (let i = 1; i < prices.length; i++) {
        if (prices[i] > prices[i - 1]) {
            profit += prices[i] - prices[i - 1];
        }
    }
    return profit;
}

function maxProfitTwoTransactions(prices) {
    const n = prices.length;
    if (n === 0) return 0;

    const leftProfits = Array(n).fill(0);
    let minPrice = prices[0];

    // Forward pass: max profit if sold at day i (1st transaction)
    for (let i = 1; i < n; i++) {
        minPrice = Math.min(minPrice, prices[i]);
        leftProfits[i] = Math.max(leftProfits[i - 1], prices[i] - minPrice);
    }

    let maxProfit = 0;
    let maxPrice = prices[n - 1];
    let rightProfit = 0;

    // Backward pass: max profit if bought at day i (2nd transaction)
    for (let i = n - 2; i >= 0; i--) {
        maxPrice = Math.max(maxPrice, prices[i]);
        rightProfit = Math.max(rightProfit, maxPrice - prices[i]);
        maxProfit = Math.max(maxProfit, rightProfit + leftProfits[i]);
    }

    return maxProfit;
}

function maxSubarraySum(nums) {
    let maxSum = nums[0];
    let currentSum = nums[0];

    for (let i = 1; i < nums.length; i++) {
        currentSum = Math.max(nums[i], currentSum + nums[i]);
        maxSum = Math.max(maxSum, currentSum);
    }

    return maxSum;
}

function rleCompress(s) {
    let res = "";
    let i = 0;

    while (i < s.length) {
        let count = 1;
        while (i + count < s.length && s[i + count] === s[i]) {
            count++;
        }

        // Split into chunks of max 9
        let remaining = count;
        while (remaining > 9) {
            res += "9" + s[i];
            remaining -= 9;
        }
        res += remaining + s[i];

        i += count;
    }

    return res;
}


function spiralOrder(matrix) {
    const result = [];

    if (matrix.length === 0 || matrix[0].length === 0) {
        return result;
    }

    let top = 0;
    let bottom = matrix.length - 1;
    let left = 0;
    let right = matrix[0].length - 1;

    while (top <= bottom && left <= right) {
        // left to right
        for (let col = left; col <= right; col++) {
            result.push(matrix[top][col]);
        }
        top++;

        // top to bottom
        for (let row = top; row <= bottom; row++) {
            result.push(matrix[row][right]);
        }
        right--;

        // right to left
        if (top <= bottom) {
            for (let col = right; col >= left; col--) {
                result.push(matrix[bottom][col]);
            }
            bottom--;
        }

        // bottom to top
        if (left <= right) {
            for (let row = bottom; row >= top; row--) {
                result.push(matrix[row][left]);
            }
            left++;
        }
    }

    return result;
}

function minJumpsToEnd(arr) {
    const n = arr.length;
    if (n === 0 || arr[0] === 0) return 0;
    let jumps = 0;
    let currentEnd = 0;
    let farthest = 0;

    for (let i = 0; i < n - 1; i++) {
        farthest = Math.max(farthest, i + arr[i]);
        if (i === currentEnd) {
            jumps++;
            currentEnd = farthest;
            if (currentEnd >= n - 1) {
                return jumps;
            }
        }
    }

    return currentEnd >= n - 1 ? jumps : 0;
}

function findMathExpressions(num, target) {
    const res = [];

    function backtrack(index, path, evalVal, prevOperand) {
        if (index === num.length) {
            if (evalVal === target) {
                res.push(path);
            }
            return;
        }

        for (let i = index + 1; i <= num.length; i++) {
            const part = num.slice(index, i);
            if (part.length > 1 && part[0] === '0') break; // skip leading zeros

            const cur = parseInt(part);
            if (index === 0) {
                backtrack(i, part, cur, cur);
            } else {
                backtrack(i, path + "+" + part, evalVal + cur, cur);
                backtrack(i, path + "-" + part, evalVal - cur, -cur);
                backtrack(i, path + "*" + part, evalVal - prevOperand + prevOperand * cur, prevOperand * cur);
            }
        }
    }

    backtrack(0, "", 0, 0);
    return res;
}

function hammingEncode(num) {
    const dataBits = num.toString(2).split('').map(Number); // binary MSB-first

    // Step 1: calculate total encoded length
    let dataLen = dataBits.length;
    let totalLen = 1; // account for parity at position 0
    while (Math.pow(2, totalLen - totalLen.toString(2).split('1').length + 1) < dataLen + totalLen + 1) {
        totalLen++;
    }
    totalLen += dataLen;

    // Build empty encoded array with placeholders
    let encoded = [];
    let dataIndex = 0;
    for (let i = 0; i < totalLen; i++) {
        if (isPowerOfTwo(i)) {
            encoded[i] = 0; // parity placeholder
        } else {
            encoded[i] = dataBits[dataIndex++];
        }
    }

    // Calculate parity bits
    for (let p = 1; p < totalLen; p <<= 1) {
        let parity = 0;
        for (let i = p; i < totalLen; i += 2 * p) {
            for (let j = i; j < i + p && j < totalLen; j++) {
                parity ^= encoded[j];
            }
        }
        encoded[p] = parity;
    }

    // Set overall parity bit at position 0
    const totalParity = encoded.reduce((acc, bit) => acc ^ bit, 0);
    encoded[0] = totalParity;

    return encoded.join('');
}

function maxProfitKTransactions(k, prices) {
    const n = prices.length;
    if (n === 0 || k === 0) return 0;

    // If k >= n/2, same as unlimited transactions
    if (k >= n / 2) {
        let profit = 0;
        for (let i = 1; i < n; i++) {
            if (prices[i] > prices[i - 1]) {
                profit += prices[i] - prices[i - 1];
            }
        }
        return profit;
    }

    // DP table
    const dp = Array.from({ length: k + 1 }, () => Array(n).fill(0));

    for (let t = 1; t <= k; t++) {
        let maxSoFar = -prices[0];
        for (let d = 1; d < n; d++) {
            dp[t][d] = Math.max(dp[t][d - 1], prices[d] + maxSoFar);
            maxSoFar = Math.max(maxSoFar, dp[t - 1][d] - prices[d]);
        }
    }

    return dp[k][n - 1];
}

function sanitizeParentheses(s) {
    const res = [];
    const visited = new Set();
    const queue = [s];
    let found = false;

    function isValid(str) {
        let count = 0;
        for (const ch of str) {
            if (ch === '(') count++;
            else if (ch === ')') {
                count--;
                if (count < 0) return false;
            }
        }
        return count === 0;
    }

    while (queue.length > 0) {
        const str = queue.shift();
        if (isValid(str)) {
            res.push(str);
            found = true;
        }
        if (found) continue; // once we find any valid string, don't generate further removals

        for (let i = 0; i < str.length; i++) {
            if (str[i] !== '(' && str[i] !== ')') continue;
            const next = str.slice(0, i) + str.slice(i + 1);
            if (!visited.has(next)) {
                visited.add(next);
                queue.push(next);
            }
        }
    }

    return res.length ? res : [""];
}

function bigIntSqrt(nStr) {
    const n = (typeof nStr === 'bigint') ? nStr : BigInt(nStr);
    if (n === 0n || n === 1n) return n.toString();

    let low = 0n;
    let high = n;
    let ans = 0n;

    while (low <= high) {
        const mid = (low + high) >> 1n;
        const square = mid * mid;

        if (square === n) {
            return mid.toString();
        } else if (square < n) {
            ans = mid;
            low = mid + 1n;
        } else {
            high = mid - 1n;
        }
    }

    // Now apply rounding correction:
    const lower = ans;
    const higher = ans + 1n;

    if ((higher * higher - n) < (n - lower * lower)) {
        return higher.toString();
    } else {
        return lower.toString();
    }
}

function generateIPAddresses(s) {
    const res = [];

    function backtrack(start, path) {
        if (path.length === 4) {
            if (start === s.length) {
                res.push(path.join('.'));
            }
            return;
        }

        for (let len = 1; len <= 3; len++) {
            if (start + len > s.length) break;
            const part = s.slice(start, start + len);
            if ((part.length > 1 && part[0] === '0') || parseInt(part) > 255) continue;
            path.push(part);
            backtrack(start + len, path);
            path.pop();
        }
    }

    backtrack(0, []);
    return res;
}

function vigenereEncrypt(plaintext, keyword) {
    const A = 'A'.charCodeAt(0);
    let result = '';

    for (let i = 0; i < plaintext.length; i++) {
        const p = plaintext.charCodeAt(i) - A;
        const k = keyword.charCodeAt(i % keyword.length) - A;
        const c = (p + k) % 26;
        result += String.fromCharCode(c + A);
    }

    return result;
}

function minimumTrianglePathSum(triangle) {
    const dp = triangle.map(row => [...row]);  // deep copy

    for (let row = dp.length - 2; row >= 0; row--) {
        for (let col = 0; col < dp[row].length; col++) {
            dp[row][col] += Math.min(dp[row + 1][col], dp[row + 1][col + 1]);
        }
    }

    return dp[0][0];
}

function totalWaysToSumII(target, numbers) {
    const dp = Array(target + 1).fill(0);
    dp[0] = 1;

    for (const num of numbers) {
        for (let i = num; i <= target; i++) {
            dp[i] += dp[i - num];
        }
    }

    return dp[target];
}

function largestPrimeFactor(n) {
    n = BigInt(n);
    let factor = 2n;

    while (n % factor === 0n) {
        n /= factor;
    }

    factor = 3n;
    let maxFactor = 2n;

    while (factor * factor <= n) {
        if (n % factor === 0n) {
            n /= factor;
            maxFactor = factor;
        } else {
            factor += 2n;
        }
    }

    return (n > 1n ? n : maxFactor).toString();
}

function lzCompress(s) {
    let res = "";
    let i = 0;
    let isLiteral = true;

    while (i < s.length) {
        // Try back-reference first at every position
        let bestLen = 0;
        let bestBack = 0;
        for (let back = 1; back <= Math.min(9, i); back++) {
            let l = 0;
            while (l < 9 && i + l < s.length && s[i + l] === s[i + l - back]) {
                l++;
            }
            if (l > bestLen || (l === bestLen && back < bestBack)) {
                bestLen = l;
                bestBack = back;
            }
        }

        if (bestLen > 0) {
            res += bestLen + bestBack;
            i += bestLen;
            isLiteral = true;
        } else {
            // No back-reference possible, emit literal run
            let literalStart = i;
            let literalLen = 0;
            while (literalLen < 9 && i < s.length) {
                // Check if a back-reference starts at next character
                let foundBackref = false;
                for (let back = 1; back <= Math.min(9, i); back++) {
                    if (s[i] === s[i - back]) {
                        foundBackref = true;
                        break;
                    }
                }
                if (foundBackref) break;
                i++;
                literalLen++;
            }
            res += literalLen + s.slice(literalStart, literalStart + literalLen);
        }
    }
    return res;
}

function caesarEncrypt(plaintext, shift) {
    const A = 'A'.charCodeAt(0);
    const Z = 'Z'.charCodeAt(0);
    let result = "";

    for (let c of plaintext) {
        if (c === ' ') {
            result += ' ';
        } else {
            let code = c.charCodeAt(0) - A;
            let shifted = (code - shift + 26) % 26;
            result += String.fromCharCode(shifted + A);
        }
    }
    return result;
}

function compressionIII(s) {
    let res = "";
    let i = 0;
    let isLiteral = true;

    while (i < s.length) {
        if (isLiteral) {
            let literalStart = i;
            let literalLen = 0;
            while (literalLen < 9 && i < s.length) {
                let foundBackref = false;
                for (let back = Math.min(9, i); back >= 1; back--) {
                    if (s[i] === s[i - back]) {
                        foundBackref = true;
                        break;
                    }
                }
                if (foundBackref) break;
                i++;
                literalLen++;
            }
            res += literalLen + s.slice(literalStart, literalStart + literalLen);
            isLiteral = false;
        } else {
            let bestLen = 0;
            let bestBack = 0;
            for (let back = Math.min(9, i); back >= 1; back--) {
                let l = 0;
                while (l < 9 && i + l < s.length && s[i + l] === s[i + l - back]) {
                    l++;
                }
                if (l > bestLen || (l === bestLen && back > bestBack)) {
                    bestLen = l;
                    bestBack = back;
                }
            }
            if (bestLen > 0) {
                res += bestLen + bestBack;
                i += bestLen;
                isLiteral = true;
            } else {
                isLiteral = true;
            }
        }
    }
    return res;
}

function uniquePathsWithObstacles(grid) {
    const m = grid.length;
    const n = grid[0].length;
    const dp = Array.from({ length: m }, () => Array(n).fill(0));

    // Starting point
    dp[0][0] = grid[0][0] === 0 ? 1 : 0;

    // First column
    for (let i = 1; i < m; i++) {
        dp[i][0] = (grid[i][0] === 0 && dp[i-1][0] === 1) ? 1 : 0;
    }

    // First row
    for (let j = 1; j < n; j++) {
        dp[0][j] = (grid[0][j] === 0 && dp[0][j-1] === 1) ? 1 : 0;
    }

    // Fill DP table
    for (let i = 1; i < m; i++) {
        for (let j = 1; j < n; j++) {
            if (grid[i][j] === 0) {
                dp[i][j] = dp[i-1][j] + dp[i][j-1];
            }
        }
    }

    return dp[m-1][n-1];
}

