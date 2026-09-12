# DateTime and TimeSpan in generated code

The JavaScript and native WebAssembly backends implement the temporal signatures listed below through [`cad-time.mjs`](../src/il/cad-time.mjs). C# method bodies are compiled by the selected backend; the shared temporal services supply framework behavior. This includes the original netDxf `DrawingTime` Julian-calendar and editing-time methods.

Ticks use exact signed 64-bit arithmetic. A tick is 100 nanoseconds. `DateTime` supports the Gregorian range from year 1 through year 9999; `TimeSpan` supports the full signed `Int64` tick range. Calendar construction, decomposition, arithmetic, and comparisons do not pass through JavaScript `Date` or millisecond storage. Clock reads are described separately below.

## Compile once, execute on both backends

Run this ES module from an installed package or from the repository with its prebuilt `dist` assets:

```js
import { createRoslyn } from '@roslynweb/core/node';
import { compileAssembly } from '@roslynweb/core/il';
import { loadWasm } from '@roslynweb/core/wasm';

const compiler = await createRoslyn();
try {
  const assembly = await compiler.compile(`
using System;
public static class CadClock {
  public static long Duration(double seconds) =>
    TimeSpan.FromSeconds(seconds).Ticks;
  public static long MoveMonth(long ticks, int months) =>
    new DateTime(ticks, DateTimeKind.Utc).AddMonths(months).Ticks;
  public static string FormatDuration(long ticks) =>
    new TimeSpan(ticks).ToString();
}`, {
    assemblyName: 'CadClock', outputKind: 'library',
    optimization: 'release', emitPdb: false, includeInspection: true,
  });
  if (!assembly.success) throw new Error(JSON.stringify(assembly.diagnostics));

  const exports = ['CadClock.Duration', 'CadClock.MoveMonth', 'CadClock.FormatDuration'];
  const javascript = compileAssembly(assembly.inspection, {
    exports, strict: true, optimize: true,
  });
  const artifact = await compiler.emitWasm(assembly, { exports, optimize: true });
  const wasm = await loadWasm(artifact.bytes);
  try {
    for (const program of [javascript, wasm]) {
      console.log(program.invoke('CadClock::Duration', [0.125]));
      // 1250000n
      console.log(program.invoke('CadClock::MoveMonth', [621355968000000007n, 1]));
      // 621382752000000007n: the seven sub-microsecond ticks are preserved.
      console.log(program.invoke('CadClock::FormatDuration', [1250000n]));
      // "00:00:00.1250000"
    }
  } finally { wasm.dispose(); }
} finally { await compiler.close(); }
```

The public invocation APIs return C# `long` values as JavaScript `bigint`. Pass a `bigint` for precise 64-bit inputs; converting an already rounded JavaScript `number` cannot restore lost ticks. The example exports scalar ticks and text, so applications do not need to construct internal temporal value records. Browser applications obtain the compiler from `@roslynweb/core`; the compilation and generated-program calls are the same.

Keep the compiler alive across edits to reuse its compilation caches. Keep each generated program alive for repeated calls. Native Wasm program disposal releases its runtime resources; the JavaScript program can be released by dropping references when no longer needed.

## DateTime signatures

All types in the tables use their C# names. Component constructor arguments are `int` unless stated otherwise.

| Surface | Admitted signatures or members |
| --- | --- |
| Tick constructors | `DateTime(long ticks)`, `DateTime(long ticks, DateTimeKind kind)` |
| Date constructor | `DateTime(year, month, day)` |
| Date/time constructors | Six components through `second`; seven through `millisecond`; eight through `microsecond`. Each of these three forms also accepts a final `DateTimeKind`. |
| Default value | `default(DateTime)` and the C# default value construction path: zero ticks, `Unspecified` kind |
| Properties | `Ticks`, `Kind`, `Year`, `Month`, `Day`, `DayOfYear`, `DayOfWeek`, `Hour`, `Minute`, `Second`, `Millisecond`, `Microsecond`, `Nanosecond`, `Date`, `TimeOfDay` |
| Clock properties | Static `Now`, `UtcNow`, `Today` |
| Constants | Static readonly `MinValue`, `MaxValue`, `UnixEpoch` |
| Tick/calendar arithmetic | `AddTicks(long)`, `AddMonths(int)`, `AddYears(int)` |
| Fractional arithmetic | `AddDays(double)`, `AddHours(double)`, `AddMinutes(double)`, `AddSeconds(double)`, `AddMilliseconds(double)`, `AddMicroseconds(double)` |
| Interval arithmetic | `Add(TimeSpan)`, `Subtract(TimeSpan)`, `Subtract(DateTime)`; corresponding `DateTime + TimeSpan`, `DateTime - TimeSpan`, and `DateTime - DateTime` operators |
| Calendar helpers | Static `IsLeapYear(int)`, `DaysInMonth(int, int)`, `SpecifyKind(DateTime, DateTimeKind)` |
| Comparison | Instance `Equals(DateTime)`, `Equals(object)`, `CompareTo(DateTime)`, `CompareTo(object)`, `GetHashCode()`; static `Equals(DateTime, DateTime)` and `Compare(DateTime, DateTime)`; `==`, `!=`, `<`, `<=`, `>`, `>=` |

`AddMonths` and `AddYears` clip a day that does not exist in the destination month, preserving the time of day and kind. Fractional additions follow the .NET 10 whole-unit/fractional-unit calculation, retaining 100-nanosecond precision where the input permits it.

Comparison and hashing use ticks and ignore kind. `SpecifyKind` changes the kind without shifting ticks. `Date` retains the original kind. These operations do not perform timezone conversion. Invalid date components, invalid kinds, and arithmetic outside the supported range raise managed exceptions.

Temporal values retain value-copy behavior in locals, arrays, fields, and boxes. Static readonly constants have independent value reads; generated runtime field-address services reject writes. The tested constrained `Object.Equals` and `Object.GetHashCode` paths dispatch to the temporal implementation.

## TimeSpan signatures

| Surface | Admitted signatures or members |
| --- | --- |
| Tick constructor | `TimeSpan(long ticks)` |
| Component constructors | `(int hours, int minutes, int seconds)`; `(int days, int hours, int minutes, int seconds)`; the latter plus `int milliseconds`; the latter plus both `int milliseconds, int microseconds` |
| Default value | `default(TimeSpan)` and the C# default value construction path: zero ticks |
| Component properties | `Ticks`, `Days`, `Hours`, `Minutes`, `Seconds`, `Milliseconds`, `Microseconds`, `Nanoseconds` |
| Total properties | `TotalDays`, `TotalHours`, `TotalMinutes`, `TotalSeconds`, `TotalMilliseconds`, `TotalMicroseconds`, `TotalNanoseconds` |
| Constants | Static readonly `Zero`, `MinValue`, `MaxValue` |
| Double factories | `FromDays(double)`, `FromHours(double)`, `FromMinutes(double)`, `FromSeconds(double)`, `FromMilliseconds(double)`, `FromMicroseconds(double)` |
| Tick factory | `FromTicks(long)` |
| Integer factories | The exact overloads in the next table |
| Arithmetic | `Add(TimeSpan)`, `Subtract(TimeSpan)`, `Negate()`, `Duration()`, unary `+` and `-`, binary `+` and `-` |
| Scaling | `Multiply(double)`, `Divide(double)`, `Divide(TimeSpan)`; `TimeSpan * double`, `double * TimeSpan`, `TimeSpan / double`, `TimeSpan / TimeSpan` |
| Comparison | Instance `Equals(TimeSpan)`, `Equals(object)`, `CompareTo(TimeSpan)`, `CompareTo(object)`, `GetHashCode()`; static `Equals(TimeSpan, TimeSpan)` and `Compare(TimeSpan, TimeSpan)`; `==`, `!=`, `<`, `<=`, `>`, `>=` |
| Formatting | `ToString()`, `ToString(string)`, `ToString(string, IFormatProvider)` for null/empty format and `c`, `t`, `T` |

The integer factories include the .NET 10 component overloads. C# supplies omitted optional arguments before emitting the method call.

| Factory | Exact integer parameter lists |
| --- | --- |
| `FromDays` | `(int days)`; `(int days, int hours, long minutes, long seconds, long milliseconds, long microseconds)` |
| `FromHours` | `(int hours)`; `(int hours, long minutes, long seconds, long milliseconds, long microseconds)` |
| `FromMinutes` | `(long minutes)`; `(long minutes, long seconds, long milliseconds, long microseconds)` |
| `FromSeconds` | `(long seconds)`; `(long seconds, long milliseconds, long microseconds)` |
| `FromMilliseconds` | `(long milliseconds)`; `(long milliseconds, long microseconds)` |
| `FromMicroseconds` | `(long microseconds)` |

Double factories truncate fractional ticks after unit scaling, with the tested .NET 10 range and special-value behavior. Multiplication and division round to the nearest tick with ties to even. Division by another `TimeSpan` returns a `double` ratio, including the applicable IEEE infinity/NaN cases. Integer factories retain exact arithmetic. Component constructors preserve the pinned .NET 10 signed 64-bit microsecond accumulation behavior, including its unchecked overflow cases.

Negative component properties truncate toward zero and retain negative remainders. Total properties return `double`, which can lose low tick bits for large values. Only `TotalMilliseconds` clamps at the framework's whole-millisecond extrema; the other totals use their ordinary floating-point conversion. Constant formatting is invariant, so the provider does not change the `c`/`t`/`T` output. Unsupported format strings fail explicitly.

## Clocks and unsupported operations

`UtcNow` reads the JavaScript host's wall clock and marks the result as UTC. `Now` reads that same host's local civil date/time and marks the result as Local. `Today` returns local midnight with Local kind. These reads have JavaScript clock resolution, normally milliseconds; storing them as ticks does not create additional clock precision. Browser privacy settings may reduce resolution further.

Clock values are nondeterministic and can change if the system clock changes. The host's configured timezone and daylight-saving rules control local values. The generated runtime does not pretend the local zone is UTC, does not supply a separate timezone database, and does not preserve the CLR's internal ambiguous-local-time flag. Managed Wasm and generated backends may observe different clock instants or timezone configurations. The integration fixture checks clock kind and shape rather than asserting identical timestamps across separate executions.

The generated services do not implement DateTime parsing or formatting, alternate-calendar constructors, timezone conversion APIs, binary/file-time/OLE-date conversion, `DateTimeOffset`, `DateOnly`, or `TimeOnly`. DateTime formatting through object formatting also fails explicitly. TimeSpan parsing and general/custom formatting are outside the listed surface. Raw native layouts, pointer reinterpretation, and `sizeof` support do not follow from temporal value support.

A supported signature can still receive a value outside its documented domain. That produces a managed exception or an explicit runtime limitation. Execution is not retried on another backend after side effects. Use the managed `.NET Wasm` backend when the generated signatures are insufficient.

## Verification

The checked-in [C# fixture](../tests/cad-time-fixture.cs), [real inspection output](../tests/cad-time-fixture.json), and [expected results](../tests/cad-time-baseline.json) cover **319 scenarios**. Every scenario matches managed .NET Wasm and an independent native .NET 10 run. Generated execution matches the oracle in three JavaScript optimization modes and two native Wasm modes.

Coverage includes full-range tick values, deterministic random calendar dates, signed interval components, min/max constants, value copying and boxing, month/year clipping, fractional arithmetic, floating-point boundaries and ties, overflow/argument errors, constant formatting, and the original netDxf drawing-time formulas. Clock coverage verifies its documented nondeterministic contract. The focused suite currently reports **962 passing tests**: per-scenario JavaScript tests, two grouped native Wasm tests, and three direct contract checks.

```sh
node tests/cad-time-integration.mjs
DOTNET=dotnet node tests/cad-time-verify-native.mjs
node --test tests/cad-time.test.mjs
```

The native verifier compares results against the existing managed baseline and does not rewrite it. To deliberately regenerate the managed inspection and baseline, use `node tests/cad-time-integration.mjs --update`, then rerun the independent native verifier and generated tests.
