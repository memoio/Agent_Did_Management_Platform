import { readFileSync, writeFileSync } from "node:fs";

const validatorPath = "/app/src/rpc/validation/SafeValidator.ts";
let source = readFileSync(validatorPath, "utf8");

function replaceOnce(search, replacement, label) {
  const first = source.indexOf(search);
  if (first === -1 || source.indexOf(search, first + search.length) !== -1) {
    throw new Error(`Alto patch precondition failed for ${label}`);
  }
  source = source.replace(search, replacement);
}

replaceOnce(
  "    EntryPointV06Abi,\n",
  "    EntryPointV06Abi,\n    EntryPointV07Abi,\n",
  "EntryPointV07Abi import",
);

replaceOnce(
  "    decodeErrorResult,\n",
  "    decodeErrorResult,\n    decodeFunctionResult,\n",
  "decodeFunctionResult import",
);

replaceOnce(
  `        // Decode the validation result from the revert data
        const { errorName, args } = decodeErrorResult({
            abi: pimlicoSimulationsAbi,
            data: resultData
        })

        if (errorName !== "ValidationResult") {
            let errorCode = ERC7769Errors.SimulateValidation
            const errorMessage = errorName || "Unknown validation error"

            if (errorMessage.includes("AA24")) {
                errorCode = ERC7769Errors.InvalidSignature
            }

            if (errorMessage.includes("AA31")) {
                errorCode = ERC7769Errors.PaymasterDepositTooLow
            }

            throw new RpcError(errorMessage, errorCode)
        }

        const validationResult = args[0] as ValidationResult07`,
  `        let validationResult: ValidationResult07

        // Anvil's call tracer can report the nested EntryPoint exit as the
        // final call. In that case the successful simulation result is still
        // wrapped by DelegateAndRevert(bool,bytes). Unwrap only that canonical
        // selector; every other result retains Alto's fail-closed behavior.
        if (resultData.startsWith("0x99410554")) {
            const { errorName, args } = decodeErrorResult({
                abi: EntryPointV07Abi,
                data: resultData
            })
            if (errorName !== "DelegateAndRevert") {
                throw new RpcError(
                    errorName || "Unknown EntryPoint simulation error",
                    ERC7769Errors.SimulateValidation
                )
            }

            const [delegateCallSuccess, delegateCallResult] = args as readonly [
                boolean,
                Hex
            ]
            if (!delegateCallSuccess) {
                throw new RpcError(
                    delegateCallResult,
                    ERC7769Errors.SimulateValidation
                )
            }

            validationResult = decodeFunctionResult({
                abi: pimlicoSimulationsAbi,
                functionName: "simulateValidation",
                data: delegateCallResult
            }) as ValidationResult07
        } else {
            const { errorName, args } = decodeErrorResult({
                abi: pimlicoSimulationsAbi,
                data: resultData
            })

            if (errorName !== "ValidationResult") {
                let errorCode = ERC7769Errors.SimulateValidation
                const errorMessage = errorName || "Unknown validation error"

                if (errorMessage.includes("AA24")) {
                    errorCode = ERC7769Errors.InvalidSignature
                }

                if (errorMessage.includes("AA31")) {
                    errorCode = ERC7769Errors.PaymasterDepositTooLow
                }

                throw new RpcError(errorMessage, errorCode)
            }

            validationResult = args[0] as ValidationResult07
        }`,
  "SafeValidator v0.7 DelegateAndRevert unwrap",
);

writeFileSync(validatorPath, source);
