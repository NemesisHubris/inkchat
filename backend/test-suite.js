/**
 * SlateChat Automated Security Verification Test Suite
 * File Location: backend/test-suite.js
 *
 * This script runs automated integration tests using native Node.js fetch
 * to verify our security perimeter, including anti-spam, username moderation,
 * global room cooldowns, and cryptographic admin locks.
 */

const BASE_URL = process.env.TEST_API_URL || "https://slatechat-proxy.kindlemodshelf.workers.dev";
const ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD || "inkchat-admin-2026";

console.log("=================================================================");
console.log("🔒 InkChat Security & Anti-Spam Automated Integration Test Suite");
console.log(`📡 Target API Gateway: ${BASE_URL}`);
console.log("=================================================================\n");

// Helper: Sleep utility
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Helper: Print test outcome
const printOutcome = (testName, passed, details = "") => {
    if (passed) {
        console.log(`✅ PASSED: [${testName}]`);
    } else {
        console.log(`❌ FAILED: [${testName}]`);
        if (details) console.log(`   └─ Error: ${details}`);
    }
};

// Helper: Log in as admin and return the token, or null on failure
async function adminLogin() {
    const res = await fetch(`${BASE_URL}/api/admin/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: ADMIN_PASSWORD })
    });
    if (res.status === 200) {
        const data = await res.json();
        return data.token || null;
    }
    return null;
}

/**
 * Main Test Execution Runner
 */
async function runTestSuite() {
    let activeTestToken = null;
    let activeTestDeviceId = null;
    let activeTestUsername = null;
    let adminToken = null;

    // -------------------------------------------------------------------------
    // PRE-REQ: Establish a genuine session for standard anti-spam testing
    // -------------------------------------------------------------------------
    try {
        const username = "tester_" + Math.floor(Math.random() * 10000);
        const regRes = await fetch(`${BASE_URL}/api/register`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                username: username,
                password: "SecureTestPassword123"
            })
        });
        if (regRes.status === 200) {
            const data = await regRes.json();
            activeTestToken = data.token;
            activeTestUsername = username;
            activeTestDeviceId = data.ink_device_id; // Server-assigned UUID
            console.log(`🔑 Pre-requisite: Established test session for user '${username}'`);
        } else {
            const errText = await regRes.text();
            console.log(`⚠️  Pre-requisite registration returned HTTP ${regRes.status}: ${errText}`);
        }
    } catch (e) {
        console.log("⚠️  Could not pre-establish test session: " + e.message);
    }

    console.log("\n------------------------- Executing Tests -------------------------\n");

    // -------------------------------------------------------------------------
    // Test 1: Pre-Registration Username Moderation
    // -------------------------------------------------------------------------
    try {
        const hostileUsername = "kill-you-now"; // Explicit threat triggering safety gate
        const res = await fetch(`${BASE_URL}/api/register`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                username: hostileUsername,
                password: "SomePassword123"
            })
        });

        const text = await res.text();
        let isCorrectMessage = false;
        try {
            const json = JSON.parse(text);
            isCorrectMessage = json.message === "Registration rejected: Username violates our community content policy.";
        } catch (err) {}

        const passed = res.status === 400 && isCorrectMessage;
        printOutcome("Test 1: Pre-Registration Username Moderation", passed, `HTTP Status ${res.status}, Payload: ${text}`);
    } catch (e) {
        printOutcome("Test 1: Pre-Registration Username Moderation", false, e.message);
    }

    // Ensure cooldown clears before starting anti-spam tests
    await sleep(1500);

    // -------------------------------------------------------------------------
    // Test 2: Global Spam Cooldown
    // -------------------------------------------------------------------------
    try {
        const token = activeTestToken || "valid-mock-session-token";
        const deviceId = activeTestDeviceId;

        // Fire first valid message and await its complete successful execution
        const res1 = await fetch(`${BASE_URL}/api/send-message`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                text: "Global Cooldown Test Message A",
                sessionToken: token,
                ink_device_id: deviceId
            })
        });

        // Fire second message immediately after the first finishes to trigger room cooldown (1 second)
        const res2 = await fetch(`${BASE_URL}/api/send-message`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                text: "Global Cooldown Test Message B",
                sessionToken: token,
                ink_device_id: deviceId
            })
        });

        const text2 = await res2.text();
        const passed = res2.status === 429;
        printOutcome("Test 2: Global Spam Cooldown", passed, `HTTP Status of duplicate: ${res2.status}, Payload: ${text2}`);
    } catch (e) {
        printOutcome("Test 2: Global Spam Cooldown", false, e.message);
    }

    // Wait for room cooldown to clear
    await sleep(2000);

    // -------------------------------------------------------------------------
    // Test 3: Duplicate Message Blocker
    // -------------------------------------------------------------------------
    try {
        const token = activeTestToken || "valid-mock-session-token";
        const deviceId = activeTestDeviceId;
        const duplicateText = "Unique anti-spam string: " + Date.now();

        // 1. Send first message
        const res1 = await fetch(`${BASE_URL}/api/send-message`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                text: duplicateText,
                sessionToken: token,
                ink_device_id: deviceId
            })
        });

        // 2. Wait 1.5 seconds to pass room cooldown
        await sleep(1800);

        // 3. Send identical text again
        const res2 = await fetch(`${BASE_URL}/api/send-message`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                text: duplicateText,
                sessionToken: token,
                ink_device_id: deviceId
            })
        });

        const text3 = await res2.text();
        const passed = res2.status === 409;
        printOutcome("Test 3: Duplicate Message Blocker", passed, `HTTP Status: ${res2.status}, Payload: ${text3}`);
    } catch (e) {
        printOutcome("Test 3: Duplicate Message Blocker", false, e.message);
    }

    // -------------------------------------------------------------------------
    // Test 4: Unauthenticated Admin Interface Lockout
    // -------------------------------------------------------------------------
    try {
        const res = await fetch(`${BASE_URL}/api/admin/user-lookup?username=test`, {
            method: "GET",
            headers: {
                // Intentionally omitting X-Admin-Token
                "Content-Type": "application/json"
            }
        });

        const text = await res.text();
        const passed = res.status === 401;
        printOutcome("Test 4: Unauthenticated Admin Interface Lockout", passed, `HTTP Status: ${res.status}, Payload: ${text}`);
    } catch (e) {
        printOutcome("Test 4: Unauthenticated Admin Interface Lockout", false, e.message);
    }

    // -------------------------------------------------------------------------
    // Test 5: Missing Required Fields Rejected on Register
    // -------------------------------------------------------------------------
    try {
        // Omit username — backend must reject with 400
        const res = await fetch(`${BASE_URL}/api/register`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                password: "SecureTestPassword123"
            })
        });

        const text = await res.text();
        const passed = res.status === 400;
        printOutcome("Test 5: Missing Required Fields Rejected on Register", passed, `HTTP Status: ${res.status}, Payload: ${text}`);
    } catch (e) {
        printOutcome("Test 5: Missing Required Fields Rejected on Register", false, e.message);
    }

    // -------------------------------------------------------------------------
    // Test 6: Surgical Device-Level Ban Enforcement
    // -------------------------------------------------------------------------
    try {
        // 1. Register a new user to obtain a server-assigned device ID
        const testBannedUser = "dev_ban_test_" + Math.floor(Math.random() * 10000);
        const devRegRes = await fetch(`${BASE_URL}/api/register`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                username: testBannedUser,
                password: "SecureTestPassword123"
            })
        });

        const devRegData = await devRegRes.json();
        const targetDeviceId = devRegData.ink_device_id;
        const targetToken = devRegData.token;

        // 2. Authenticate as Admin to execute device ban
        const localAdminToken = await adminLogin();

        if (localAdminToken && targetDeviceId && targetToken) {
            // 3. Ban the target device ID
            const banRes = await fetch(`${BASE_URL}/api/admin/ban`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "X-Admin-Token": localAdminToken
                },
                body: JSON.stringify({
                    type: "device",
                    target: targetDeviceId
                })
            });

            // 4. Attempt to send a message with the now-banned device ID
            await sleep(500);
            const blockedSendRes = await fetch(`${BASE_URL}/api/send-message`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    text: "This should be blocked by device ban",
                    sessionToken: targetToken,
                    ink_device_id: targetDeviceId
                })
            });

            const sendData = await blockedSendRes.text();
            let isCorrectError = false;
            try {
                const json = JSON.parse(sendData);
                isCorrectError = json.message === "This hardware node has been restricted permanently.";
            } catch (err) {}

            const passed = banRes.status === 200 && blockedSendRes.status === 403 && isCorrectError;
            printOutcome("Test 6: Surgical Device-Level Ban Enforcement", passed, `Ban Status: ${banRes.status}, Send Status: ${blockedSendRes.status}, Payload: ${sendData}`);
        } else {
            printOutcome("Test 6: Surgical Device-Level Ban Enforcement", false, "Skipped due to missing admin credentials or failed device registration.");
        }
    } catch (e) {
        printOutcome("Test 6: Surgical Device-Level Ban Enforcement", false, e.message);
    }

    // -------------------------------------------------------------------------
    // Test 7: Surgical Account-Level Ban Enforcement
    // -------------------------------------------------------------------------
    try {
        const testBannedUser = "banned_user_" + Math.floor(Math.random() * 10000);

        // 1. Create a new user profile — server assigns the device ID
        const regRes = await fetch(`${BASE_URL}/api/register`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                username: testBannedUser,
                password: "SecureTestPassword123"
            })
        });

        const regData = await regRes.json();
        const userToken = regData.token;
        const userDeviceId = regData.ink_device_id;

        // 2. Authenticate as Admin to execute account ban
        const localAdminToken = await adminLogin();

        if (localAdminToken && userToken) {
            // 3. Ban the target account
            const banRes = await fetch(`${BASE_URL}/api/admin/ban`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "X-Admin-Token": localAdminToken
                },
                body: JSON.stringify({
                    type: "account",
                    target: testBannedUser
                })
            });

            // 4. Banned accounts have their live sessions revoked immediately
            const sendRes = await fetch(`${BASE_URL}/api/send-message`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    text: "This should be blocked by account ban",
                    sessionToken: userToken,
                    ink_device_id: userDeviceId
                })
            });

            const sendData = await sendRes.text();
            let isCorrectError = false;
            try {
                const json = JSON.parse(sendData);
                isCorrectError = json.message === "Unauthorized: Invalid or expired session token.";
            } catch (err) {}

            const passed = banRes.status === 200 && sendRes.status === 401 && isCorrectError;
            printOutcome("Test 7: Surgical Account-Level Ban Enforcement", passed, `Ban Status: ${banRes.status}, Send Status: ${sendRes.status}, Payload: ${sendData}`);
        } else {
            printOutcome("Test 7: Surgical Account-Level Ban Enforcement", false, "Skipped due to missing credentials.");
        }
    } catch (e) {
        printOutcome("Test 7: Surgical Account-Level Ban Enforcement", false, e.message);
    }

    // -------------------------------------------------------------------------
    // Pre-req for Admin Tests: Login as Admin
    // -------------------------------------------------------------------------
    adminToken = null;
    try {
        adminToken = await adminLogin();
        if (adminToken) {
            console.log("🔑 Pre-requisite: Established Admin test session.");
        }
    } catch (e) {
        console.log("⚠️  Could not pre-establish Admin test session: " + e.message);
    }

    // -------------------------------------------------------------------------
    // Test 8: Secure Password Changing (With Old Password Validation)
    // -------------------------------------------------------------------------
    try {
        const username = "tester_pwd_" + Math.floor(Math.random() * 10000);
        const regRes = await fetch(`${BASE_URL}/api/register`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                username: username,
                password: "OriginalPassword123"
            })
        });
        const regData = await regRes.json();
        const userToken = regData.token;
        const userDeviceId = regData.ink_device_id;

        // 1. Fail change password (incorrect old password)
        const failRes = await fetch(`${BASE_URL}/api/change-password`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                sessionToken: userToken,
                oldPassword: "WrongOldPassword",
                newPassword: "NewSecretPassword123"
            })
        });

        // 2. Succeed change password (correct old password)
        const successRes = await fetch(`${BASE_URL}/api/change-password`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                sessionToken: userToken,
                oldPassword: "OriginalPassword123",
                newPassword: "NewSecretPassword123"
            })
        });

        // 3. Try to login with the new password using the server-assigned device ID
        const loginRes = await fetch(`${BASE_URL}/api/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                username: username,
                password: "NewSecretPassword123",
                ink_device_id: userDeviceId
            })
        });

        const passed = failRes.status === 400 && successRes.status === 200 && loginRes.status === 200;
        printOutcome("Test 8: Secure Password Changing", passed, `Fail Status: ${failRes.status}, Success Status: ${successRes.status}, Login Status: ${loginRes.status}`);
    } catch (e) {
        printOutcome("Test 8: Secure Password Changing", false, e.message);
    }

    // -------------------------------------------------------------------------
    // Test 9: Administrative Muting (Silent Temporary Lockouts)
    // -------------------------------------------------------------------------
    try {
        if (adminToken && activeTestToken) {
            const username = activeTestUsername || "tester_5366";

            // 1. Mute the user for 4 seconds
            const muteRes = await fetch(`${BASE_URL}/api/admin/mute-user`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "X-Admin-Token": adminToken
                },
                body: JSON.stringify({
                    username: username,
                    durationSeconds: 4
                })
            });

            // 2. Try sending a message immediately (should fail with 403)
            const postMutedRes = await fetch(`${BASE_URL}/api/send-message`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    text: "Muted Post Attempt",
                    sessionToken: activeTestToken,
                    ink_device_id: activeTestDeviceId
                })
            });

            const postText = await postMutedRes.text();
            let isMutedMsg = false;
            try {
                const json = JSON.parse(postText);
                isMutedMsg = json.message === "Access Denied: You have been temporarily muted by an administrator.";
            } catch (err) {}

            // 3. Wait 5 seconds for mute to expire
            console.log("⏱️  Waiting 5 seconds for mute lock to clear naturally...");
            await sleep(5000);

            // 4. Try sending again (should succeed, cooldown cleared too)
            const postUnmutedRes = await fetch(`${BASE_URL}/api/send-message`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    text: "Unmuted Success Post",
                    sessionToken: activeTestToken,
                    ink_device_id: activeTestDeviceId
                })
            });

            const passed = muteRes.status === 200 && postMutedRes.status === 403 && isMutedMsg && postUnmutedRes.status === 200;
            printOutcome("Test 9: Administrative User Muting", passed, `Mute Status: ${muteRes.status}, Post Muted Status: ${postMutedRes.status}, Post Unmuted Status: ${postUnmutedRes.status}`);
        } else {
            printOutcome("Test 9: Administrative User Muting", false, "Skipped due to missing session credentials.");
        }
    } catch (e) {
        printOutcome("Test 9: Administrative User Muting", false, e.message);
    }

    // -------------------------------------------------------------------------
    // Test 10: Inline Administrative Message Deletion (LREM)
    // -------------------------------------------------------------------------
    try {
        if (adminToken && activeTestToken) {
            const uniqueText = "Delete me: " + Date.now();

            // 1. Send unique message
            await sleep(1500); // clear cooldown
            const postRes = await fetch(`${BASE_URL}/api/send-message`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    text: uniqueText,
                    sessionToken: activeTestToken,
                    ink_device_id: activeTestDeviceId
                })
            });

            // 2. Fetch messages to locate exact JSON string
            const getRes = await fetch(`${BASE_URL}/api/get-messages`);
            const messages = await getRes.json();
            let rawMsg = null;
            for (let i = 0; i < messages.length; i++) {
                const parsed = JSON.parse(messages[i]);
                if (parsed.text === uniqueText) {
                    rawMsg = messages[i];
                    break;
                }
            }

            // 3. Delete the message
            let delRes = { status: 500 };
            if (rawMsg) {
                delRes = await fetch(`${BASE_URL}/api/admin/delete-message`, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "X-Admin-Token": adminToken
                    },
                    body: JSON.stringify({ messageRaw: rawMsg })
                });
            }

            // 4. Verify message is gone
            const getFinalRes = await fetch(`${BASE_URL}/api/get-messages`);
            const finalMessages = await getFinalRes.json();
            let found = false;
            for (let j = 0; j < finalMessages.length; j++) {
                const parsed = JSON.parse(finalMessages[j]);
                if (parsed.text === uniqueText) {
                    found = true;
                    break;
                }
            }

            const passed = postRes.status === 200 && delRes.status === 200 && !found;
            printOutcome("Test 10: Inline Message Deletion", passed, `Post Status: ${postRes.status}, Delete Status: ${delRes.status}, Still Found: ${found}`);
        } else {
            printOutcome("Test 10: Inline Message Deletion", false, "Skipped due to missing session credentials.");
        }
    } catch (e) {
        printOutcome("Test 10: Inline Message Deletion", false, e.message);
    }

    // -------------------------------------------------------------------------
    // Test 11: Global Administrative Chat Purging (DEL)
    // -------------------------------------------------------------------------
    try {
        if (adminToken) {
            // 1. Purge all logs
            const purgeRes = await fetch(`${BASE_URL}/api/admin/purge-messages`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "X-Admin-Token": adminToken
                }
            });

            // 2. Fetch messages to verify list is deleted
            const getRes = await fetch(`${BASE_URL}/api/get-messages`);
            const messages = await getRes.json();
            const isEmpty = messages.length === 0;

            const passed = purgeRes.status === 200 && isEmpty;
            printOutcome("Test 11: Absolute Chat Log Purging", passed, `Purge Status: ${purgeRes.status}, Length: ${messages.length}`);
        } else {
            printOutcome("Test 11: Absolute Chat Log Purging", false, "Skipped due to missing session credentials.");
        }
    } catch (e) {
        printOutcome("Test 11: Absolute Chat Log Purging", false, e.message);
    }

    // -------------------------------------------------------------------------
    // Test 12: Session Cookie Assertion
    // -------------------------------------------------------------------------
    try {
        const username = "cookie_tester_" + Math.floor(Math.random() * 10000);
        const regRes = await fetch(`${BASE_URL}/api/register`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                username: username,
                password: "SecureTestPassword123"
            })
        });

        const rawCookieHeader = regRes.headers.get("set-cookie") || "";
        const hasSessionCookie = rawCookieHeader.indexOf("inkchat_session=") !== -1;
        const hasMaxAge = rawCookieHeader.indexOf("Max-Age=2592000") !== -1;
        const hasHttpOnly = rawCookieHeader.indexOf("HttpOnly") !== -1;

        const passed = regRes.status === 200 && hasSessionCookie && hasMaxAge && hasHttpOnly;
        printOutcome("Test 12: Session Cookie Set", passed, `Set-Cookie Header: ${rawCookieHeader}`);
    } catch (e) {
        printOutcome("Test 12: Session Cookie Set", false, e.message);
    }

    console.log("\n=================================================================");
    console.log("🏁 Verification Completed.");
    console.log("=================================================================");
}

runTestSuite();
