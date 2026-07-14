# Security Specification: Firebase Cloud Firestore Hardening

## 1. Data Invariants
1. Both `/settings/global` and `/state/dataset` can only be queried or modified by authenticated users with a verified email address.
2. Only the bootstrapped administrator `mohanad.md07@gmail.com` can create, update, or delete global settings or dataset state. All other write attempts must be strictly denied.
3. Document fields such as `updatedAt` must match the server timestamp (`request.time`) precisely to prevent timing attacks.

## 2. The "Dirty Dozen" Threat Payloads (Targeting Security Hardening)
1. **Unauthenticated Read on Dataset**: Trying to read `/state/dataset` without any login.
2. **Unauthenticated Write on Dataset**: Trying to modify `/state/dataset` without any login.
3. **Email Spoof Attack (Non-verified Email)**: Trying to write `/settings/global` with a valid mock login where `email_verified` is `false`.
4. **Admin Impersonation Write**: A signed-in user whose email is `intruder@gmail.com` trying to write/update `/settings/global`.
5. **Ghost Field Injection**: Inserting arbitrary fields `ghost_field_leak` inside the global settings document.
6. **Past Timestamp Attack**: Sending a historical client-provided timestamp instead of `request.time` for `updatedAt`.
7. **Future Timestamp Attack**: Sending a custom future timestamp for `updatedAt` on `/state/dataset`.
8. **Setting Resource Exhaustion**: Trying to submit an extremely massive (over 100KB) value for `vipCasesText` to exhaust read/write quotas or deny wallet.
9. **Invalid Character ID Injection**: Creating a document path variable containing insecure characters or path traversal.
10. **State Shortcutting/Bypass**: Directly writing an incomplete `DatasetState` document omitting the `updatedAt` field.
11. **Shadow Update Gate bypass**: Attempting to bypass validations during an patch update.
12. **PII Blanket Read Query**: Attempting collections-level wide unrestricted listing without credential verification.

## 3. Test Runner (Draft Representation)
The following code represents `firestore.rules.test.ts` verifying that unauthorized or invalid payloads are blocked:

```typescript
import { assertFails, assertSucceeds, initializeTestEnvironment } from "@firebase/rules-unit-testing";

describe("Firestore Security Rules", () => {
  let testEnv;

  before(async () => {
    testEnv = await initializeTestEnvironment({
      projectId: "ai-studio-applet-webapp-f4da3",
      firestore: {
        rules: `
          rules_version = '2';
          service cloud.firestore {
            match /databases/{database}/documents {
              match /{document=**} {
                allow read, write: if false;
              }
            }
          }
        `
      }
    });
  });

  it("should fail unauthenticated read on dataset state", async () => {
    const context = testEnv.unauthenticatedContext();
    await assertFails(context.firestore().doc("state/dataset").get());
  });

  it("should fail admin privilege escalation for non-admin email", async () => {
    const context = testEnv.authenticatedContext({
      uid: "user123",
      email: "intruder@gmail.com",
      email_verified: true
    });
    await assertFails(context.firestore().doc("state/dataset").set({
      vipCasesText: "test",
      updatedAt: new Date()
    }));
  });
});
```
