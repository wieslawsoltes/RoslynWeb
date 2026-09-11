using System;

public static class ArgumentExceptionsFixture
{
    private static string Snapshot(ArgumentException exception)
    {
        var range = exception as ArgumentOutOfRangeException;
        var actual = range == null ? null : range.ActualValue;
        return ((object)exception).GetType().FullName + "|" + (exception.ParamName ?? "<null>") + "|"
            + exception.Message.Replace("\n", "<LF>") + "|"
            + (exception.InnerException == null ? "<null>" : exception.InnerException.Message) + "|"
            + (actual == null ? "<null>" : actual.GetType().FullName + ":" + actual.ToString()) + "\n";
    }

    public static string Argument()
    {
        var inner = new InvalidOperationException("inner");
        return Snapshot(new ArgumentException())
            + Snapshot(new ArgumentException((string)null))
            + Snapshot(new ArgumentException(""))
            + Snapshot(new ArgumentException("message"))
            + Snapshot(new ArgumentException("message", "parameter"))
            + Snapshot(new ArgumentException(null, "parameter"))
            + Snapshot(new ArgumentException("", "parameter"))
            + Snapshot(new ArgumentException("message", ""))
            + Snapshot(new ArgumentException("message", (string)null))
            + Snapshot(new ArgumentException("message", inner))
            + Snapshot(new ArgumentException(null, inner))
            + Snapshot(new ArgumentException("message", "parameter", inner))
            + Snapshot(new ArgumentException(null, null, null));
    }

    public static string Null()
    {
        var inner = new InvalidOperationException("inner");
        return Snapshot(new ArgumentNullException())
            + Snapshot(new ArgumentNullException((string)null))
            + Snapshot(new ArgumentNullException(""))
            + Snapshot(new ArgumentNullException("parameter"))
            + Snapshot(new ArgumentNullException("parameter", "message"))
            + Snapshot(new ArgumentNullException("parameter", (string)null))
            + Snapshot(new ArgumentNullException("parameter", ""))
            + Snapshot(new ArgumentNullException("", "message"))
            + Snapshot(new ArgumentNullException(null, "message"))
            + Snapshot(new ArgumentNullException("message", inner))
            + Snapshot(new ArgumentNullException(null, inner));
    }

    public static string Range()
    {
        var inner = new InvalidOperationException("inner");
        return Snapshot(new ArgumentOutOfRangeException())
            + Snapshot(new ArgumentOutOfRangeException((string)null))
            + Snapshot(new ArgumentOutOfRangeException(""))
            + Snapshot(new ArgumentOutOfRangeException("parameter"))
            + Snapshot(new ArgumentOutOfRangeException("parameter", "message"))
            + Snapshot(new ArgumentOutOfRangeException("parameter", (string)null))
            + Snapshot(new ArgumentOutOfRangeException("parameter", ""))
            + Snapshot(new ArgumentOutOfRangeException("", "message"))
            + Snapshot(new ArgumentOutOfRangeException(null, "message"))
            + Snapshot(new ArgumentOutOfRangeException("message", inner))
            + Snapshot(new ArgumentOutOfRangeException(null, inner))
            + Snapshot(new ArgumentOutOfRangeException("parameter", 42, "message"))
            + Snapshot(new ArgumentOutOfRangeException("parameter", null, "message"))
            + Snapshot(new ArgumentOutOfRangeException(null, -4L, null))
            + Snapshot(new ArgumentOutOfRangeException("", "", ""))
            + Snapshot(new ArgumentOutOfRangeException("parameter", true, "message"))
            + Snapshot(new ArgumentOutOfRangeException("parameter", 'x', "message"));
    }

    public sealed class MutableValue
    {
        public int Value;
        public override string ToString() => "value:" + Value;
    }

    public static string MutableActualValue()
    {
        var actual = new MutableValue { Value = 7 };
        var exception = new ArgumentOutOfRangeException("parameter", actual, "message");
        var first = exception.Message;
        actual.Value = 9;
        return first + "|" + exception.Message + "|" + Object.ReferenceEquals(actual, exception.ActualValue);
    }

    public struct MutableStruct
    {
        public int Value;
        public override string ToString() { Value++; return "struct:" + Value; }
    }

    public static string BoxedActualValue()
    {
        var exception = new ArgumentOutOfRangeException("parameter", new MutableStruct { Value = 7 }, "message");
        var first = exception.Message;
        var second = exception.Message;
        return first + "|" + second + "|" + ((MutableStruct)exception.ActualValue).Value;
    }

    public static string CatchHierarchy()
    {
        try { throw new ArgumentOutOfRangeException("radius", -3.0, "Must be positive."); }
        catch (SystemException exception)
        {
            var argument = (ArgumentException)exception;
            var range = (ArgumentOutOfRangeException)exception;
            return argument.ParamName + "|" + range.ActualValue.ToString() + "|" + exception.Message;
        }
    }
}
