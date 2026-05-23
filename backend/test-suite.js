/**
 * SlateChat Automated Security Verification Test Suite
 * File Location: backend/test-suite.js
 * 
 * This script runs automated integration tests using native Node.js fetch
 * to verify our security perimeter, including anti-spam, username moderation,
 * global room cooldowns, and cryptographic admin locks.
 */

const BASE_URL = process.env.TEST_API_URL || "https://slatechat-proxy.kindlemodshelf.workers.dev";

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

/**
 * Main Test Execution Runner
 */
async function runTestSuite() {
    let activeTestToken = null;
    let activeTestFingerprint = "test-fingerprint-" + Date.now();
    let activeTestUsername = null;

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
                password: "SecureTestPassword123",
                fingerprint: activeTestFingerprint
            })
        });
        if (regRes.status === 200) {
            const data = await regRes.json();
            activeTestToken = data.token;
            activeTestUsername = username;
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
                password: "SomePassword123",
                fingerprint: "test-fingerprint-moderation"
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
        
        // Fire first valid message and await its complete successful execution
        const res1 = await fetch(`${BASE_URL}/api/send-message`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                text: "Global Cooldown Test Message A",
                sessionToken: token,
                fingerprint: activeTestFingerprint
            })
        });

        // Fire second message immediately after the first finishes to trigger room cooldown (1 second)
        const res2 = await fetch(`${BASE_URL}/api/send-message`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                text: "Global Cooldown Test Message B",
                sessionToken: token,
                fingerprint: activeTestFingerprint
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
        const duplicateText = "Unique anti-spam string: " + Date.now();

        // 1. Send first message
        const res1 = await fetch(`${BASE_URL}/api/send-message`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                text: duplicateText,
                sessionToken: token,
                fingerprint: activeTestFingerprint
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
                fingerprint: activeTestFingerprint
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
    // Test 5: Security Challenge Endpoint
    // -------------------------------------------------------------------------
    let activeNonce = null;
    try {
        const res = await fetch(`${BASE_URL}/api/security/challenge`, {
            method: "GET",
            headers: { "Content-Type": "application/json" }
        });
        
        const data = await res.json();
        const hasNonce = !!data.nonce;
        const hasTimestamp = !!data.timestamp;
        
        activeNonce = data.nonce;
        const passed = res.status === 200 && hasNonce && hasTimestamp;
        printOutcome("Test 5: Security Challenge Generation", passed, `HTTP Status: ${res.status}, Nonce: ${activeNonce}`);
    } catch (e) {
        printOutcome("Test 5: Security Challenge Generation", false, e.message);
    }

    // -------------------------------------------------------------------------
    // Test 6: Security Verify - Rejection of Incorrect Mathematical Proof
    // -------------------------------------------------------------------------
    try {
        const fakeFingerprint = Buffer.from("screen:800x600|font:121.4|silicon:10|engine:blob-active").toString("base64");
        const res = await fetch(`${BASE_URL}/api/security/verify`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                fingerprint: fakeFingerprint,
                nonce: activeNonce || "mock-nonce-123",
                proof: 99999.99 // Invalid proof
            })
        });

        const text = await res.text();
        let isCorrectMessage = false;
        try {
            const json = JSON.parse(text);
            isCorrectMessage = json.message === "Terminated: Violation of ToS Section 1 (Hardware & Telemetry Integrity Policy).";
        } catch (err) {}

        const passed = res.status === 403 && isCorrectMessage;
        printOutcome("Test 6: Security Verification Rejection", passed, `HTTP Status: ${res.status}, Payload: ${text}`);
    } catch (e) {
        printOutcome("Test 6: Security Verification Rejection", false, e.message);
    }

    // -------------------------------------------------------------------------
    // Test 7: Security Verify - Acceptance of Valid Cryptographic Proof
    // -------------------------------------------------------------------------
    try {
        const fontGeometry = "121.4";
        const fakeFingerprint = Buffer.from(`screen:800x600|font:${fontGeometry}|silicon:10|engine:blob-active`).toString("base64");
        
        // Calculate the correct proof using the same mathematical loop as the client/server
        const fontGeomFloat = parseFloat(fontGeometry);
        const integrityMultiplier = 15;
        let expectedProof = 0;
        const nonce = activeNonce;
        
        if (nonce) {
            for (let i = 0; i < nonce.length; i++) {
                const charCode = nonce.charCodeAt(i);
                expectedProof += (charCode * fontGeomFloat) + (i * integrityMultiplier);
            }
            expectedProof = Math.round(expectedProof * 10000) / 10000;

            const res = await fetch(`${BASE_URL}/api/security/verify`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    fingerprint: fakeFingerprint,
                    nonce: nonce,
                    proof: expectedProof
                })
            });

            const text = await res.text();
            let isAllowed = false;
            try {
                const json = JSON.parse(text);
                isAllowed = json.status === "ALLOWED" && json.token === fakeFingerprint;
            } catch (err) {}

            const passed = res.status === 200 && isAllowed;
            printOutcome("Test 7: Security Verification Acceptance", passed, `HTTP Status: ${res.status}, Payload: ${text}`);
        } else {
            printOutcome("Test 7: Security Verification Acceptance", false, "Skipped due to missing nonce challenge.");
        }
    } catch (e) {
        printOutcome("Test 7: Security Verification Acceptance", false, e.message);
    }

    // -------------------------------------------------------------------------
    // Pre-req for Admin Tests: Login as Admin
    // -------------------------------------------------------------------------
    let adminToken = null;
    try {
        const loginRes = await fetch(`${BASE_URL}/api/admin/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ password: "inkchat-admin-2026" })
        });
        if (loginRes.status === 200) {
            const data = await loginRes.json();
            adminToken = data.token;
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
        const pwdTestFingerprint = "test-pwd-fingerprint-" + Date.now();
        const regRes = await fetch(`${BASE_URL}/api/register`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                username: username,
                password: "OriginalPassword123",
                fingerprint: pwdTestFingerprint
            })
        });
        const regData = await regRes.json();
        const userToken = regData.token;

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

        // 3. Try to login with the new password
        const loginRes = await fetch(`${BASE_URL}/api/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                username: username,
                password: "NewSecretPassword123",
                fingerprint: pwdTestFingerprint
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
                    fingerprint: activeTestFingerprint
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
                    fingerprint: activeTestFingerprint
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
                    fingerprint: activeTestFingerprint
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

    console.log("\n=================================================================");
    console.log("🏁 Verification Completed.");
    console.log("=================================================================");
}

runTestSuite();
