// The bundled .NET WASM enables UseSystemResourceKeys. Retain its raw output in
// the oracle and expand only the five known resource keys for English messages.
export function expandArgumentExceptionResources(value) {
    return value
        .replaceAll('Arg_ArgumentException', 'Value does not fall within the expected range.')
        .replaceAll('ArgumentNull_Generic', 'Value cannot be null.')
        .replaceAll('Arg_ArgumentOutOfRangeException', 'Specified argument was out of the range of valid values.')
        .replace(/Arg_ParamName_Name, (parameter|radius)/g, "(Parameter '$1')")
        .replace(/ArgumentOutOfRange_ActualValue, ([^\n|]*)/g, 'Actual value was $1.');
}
