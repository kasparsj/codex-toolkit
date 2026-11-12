# VAL-LOCAL-PACKAGE: Independent TypeScript engine and native plugin

Surface: artifact/cli.
Needs: Actual Node and official matching PaseoSDK.
Behavior: Distribute reproducible CLI and native plugin with correct host requirements; engine transitions/auth/Git/publication run without Python/SpecKit; old local engine remains untouched, legacy running state refused as writable V2.
Evidence: Clean Node test/typecheck/package/nativecompile/load and executable invocation audit.
