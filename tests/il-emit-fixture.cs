using System;
using System.Reflection;
using System.Reflection.Emit;

public static class EmitFixture
{
    public static int Shared;
    public delegate int Binary(int left, int right);
    public sealed class Counter { public int Value; public Counter(int value) { Value = value; } public int Increment(int amount) { return Value += amount; } }
    public static int Triple(int value) => value * 3;

    public static int Add(int left, int right)
    {
        var method = new DynamicMethod("Add", typeof(int), new[] { typeof(int), typeof(int) });
        var il = method.GetILGenerator();
        il.Emit(OpCodes.Ldarg_0); il.Emit(OpCodes.Ldarg_1); il.Emit(OpCodes.Add); il.Emit(OpCodes.Ret);
        return ((Func<int,int,int>)method.CreateDelegate(typeof(Func<int,int,int>)))(left, right);
    }
    public static int CustomDelegate(int left, int right)
    {
        var method = new DynamicMethod("Multiply", typeof(int), new[] { typeof(int), typeof(int) });
        var il = method.GetILGenerator();
        il.Emit(OpCodes.Ldarg_0); il.Emit(OpCodes.Ldarg_1); il.Emit(OpCodes.Mul); il.Emit(OpCodes.Ret);
        return ((Binary)method.CreateDelegate(typeof(Binary)))(left, right);
    }
    public static int Loop(int count)
    {
        var method = new DynamicMethod("Sum", typeof(int), new[] { typeof(int) }, true);
        var il = method.GetILGenerator(256);
        var total = il.DeclareLocal(typeof(int)); var current = il.DeclareLocal(typeof(int));
        var condition = il.DefineLabel(); var body = il.DefineLabel();
        il.Emit(OpCodes.Ldc_I4_0); il.Emit(OpCodes.Stloc, total);
        il.Emit(OpCodes.Ldc_I4_0); il.Emit(OpCodes.Stloc, current); il.Emit(OpCodes.Br, condition);
        il.MarkLabel(body); il.Emit(OpCodes.Ldloc, total); il.Emit(OpCodes.Ldloc, current); il.Emit(OpCodes.Add); il.Emit(OpCodes.Stloc, total);
        il.Emit(OpCodes.Ldloc, current); il.Emit(OpCodes.Ldc_I4_1); il.Emit(OpCodes.Add); il.Emit(OpCodes.Stloc, current);
        il.MarkLabel(condition); il.Emit(OpCodes.Ldloc, current); il.Emit(OpCodes.Ldarg_0); il.Emit(OpCodes.Blt, body);
        il.Emit(OpCodes.Ldloc, total); il.Emit(OpCodes.Ret);
        return ((Func<int,int>)method.CreateDelegate(typeof(Func<int,int>)))(count);
    }
    public static int Switch(int input)
    {
        var method = new DynamicMethod("Choose", typeof(int), new[] { typeof(int) });
        var il = method.GetILGenerator(); var zero = il.DefineLabel(); var one = il.DefineLabel();
        il.Emit(OpCodes.Ldarg_0); il.Emit(OpCodes.Switch, new[] { zero, one });
        il.Emit(OpCodes.Ldc_I4_M1); il.Emit(OpCodes.Ret);
        il.MarkLabel(zero); il.Emit(OpCodes.Ldc_I4, 10); il.Emit(OpCodes.Ret);
        il.MarkLabel(one); il.Emit(OpCodes.Ldc_I4, 20); il.Emit(OpCodes.Ret);
        return ((Func<int,int>)method.CreateDelegate(typeof(Func<int,int>)))(input);
    }
    public static long ExactLong(long input)
    {
        var method = new DynamicMethod("Offset", typeof(long), new[] { typeof(long) });
        var il = method.GetILGenerator(); il.Emit(OpCodes.Ldarg_0); il.Emit(OpCodes.Ldc_I8, 9007199254740993L); il.Emit(OpCodes.Add); il.Emit(OpCodes.Ret);
        return ((Func<long,long>)method.CreateDelegate(typeof(Func<long,long>)))(input);
    }
    public static int LinkedState(int input)
    {
        Shared = input;
        var method = new DynamicMethod("Linked", typeof(int), Type.EmptyTypes, typeof(EmitFixture));
        var il = method.GetILGenerator();
        il.Emit(OpCodes.Ldsfld, typeof(EmitFixture).GetField(nameof(Shared))!);
        il.EmitCall(OpCodes.Call, typeof(EmitFixture).GetMethod(nameof(Triple))!, null);
        il.Emit(OpCodes.Dup); il.Emit(OpCodes.Stsfld, typeof(EmitFixture).GetField(nameof(Shared))!); il.Emit(OpCodes.Ret);
        var result = ((Func<int>)method.CreateDelegate(typeof(Func<int>)))();
        return result + Shared;
    }
    public static int BoundTarget(int value, int increment)
    {
        var target = new Counter(value);
        var method = new DynamicMethod("Bound", typeof(int), new[] { typeof(Counter), typeof(int) });
        var il = method.GetILGenerator();
        il.Emit(OpCodes.Ldarg_0); il.Emit(OpCodes.Ldfld, typeof(Counter).GetField(nameof(Counter.Value))!);
        il.Emit(OpCodes.Ldarg_1); il.Emit(OpCodes.Add); il.Emit(OpCodes.Ret);
        return ((Func<int,int>)method.CreateDelegate(typeof(Func<int,int>), target))(increment);
    }
    public static int ReflectedInvoke(int value)
    {
        var method = new DynamicMethod("Reflect", typeof(int), new[] { typeof(int) });
        var il = method.GetILGenerator(); il.Emit(OpCodes.Ldarg_0); il.Emit(OpCodes.Ldc_I4_2); il.Emit(OpCodes.Mul); il.Emit(OpCodes.Ret);
        return (int)method.Invoke(null, new object[] { value })!;
    }
    public static int CatchFinally(int divisor)
    {
        Shared = 0;
        var method = new DynamicMethod("Divide", typeof(int), new[] { typeof(int) });
        var il = method.GetILGenerator(); var value = il.DeclareLocal(typeof(int));
        il.BeginExceptionBlock();
        il.Emit(OpCodes.Ldc_I4, 42); il.Emit(OpCodes.Ldarg_0); il.Emit(OpCodes.Div); il.Emit(OpCodes.Stloc, value);
        il.BeginCatchBlock(typeof(DivideByZeroException));
        il.Emit(OpCodes.Pop); il.Emit(OpCodes.Ldc_I4, -1); il.Emit(OpCodes.Stloc, value);
        il.BeginFinallyBlock();
        il.Emit(OpCodes.Ldc_I4, 100); il.Emit(OpCodes.Stsfld, typeof(EmitFixture).GetField(nameof(Shared))!);
        il.EndExceptionBlock(); il.Emit(OpCodes.Ldloc, value); il.Emit(OpCodes.Ret);
        return ((Func<int,int>)method.CreateDelegate(typeof(Func<int,int>)))(divisor) + Shared;
    }
    public static string Metadata()
    {
        var method = new DynamicMethod("Metadata", typeof(int), new[] { typeof(int) });
        method.DefineParameter(1, ParameterAttributes.In, "value");
        var il = method.GetILGenerator(); var local = il.DeclareLocal(typeof(int), false);
        il.Emit(OpCodes.Ldarg_0); il.Emit(OpCodes.Ret);
        return method.Name + ":" + method.GetParameters()[0].Name + ":" + local.LocalIndex + ":" + OpCodes.Ldarg_0.Name;
    }
    public static int InvalidDelegate()
    {
        var method = new DynamicMethod("BadSignature", typeof(int), new[] { typeof(int) });
        var il = method.GetILGenerator(); il.Emit(OpCodes.Ldarg_0); il.Emit(OpCodes.Ret);
        try { method.CreateDelegate(typeof(Func<int>)); return 0; }
        catch (ArgumentException) { return 1; }
    }
    public static int InvalidLabel()
    {
        var method = new DynamicMethod("BadLabel", typeof(int), Type.EmptyTypes);
        var il = method.GetILGenerator(); var label = il.DefineLabel(); il.Emit(OpCodes.Br, label); il.Emit(OpCodes.Ret);
        try { method.CreateDelegate(typeof(Func<int>)); return 0; }
        catch (Exception) { return 1; }
    }
    public static int ReflectedDelegates()
    {
        var method = typeof(Counter).GetMethod(nameof(Counter.Increment))!;
        var target = new Counter(10);
        var closed = method.CreateDelegate<Func<int,int>>(target);
        var open = method.CreateDelegate<Func<Counter,int,int>>();
        return closed(10) + open(target, 2);
    }
    public static int CatchThrowsFinally()
    {
        Shared = 0;
        var method = new DynamicMethod("Rethrow", typeof(int), Type.EmptyTypes);
        var il = method.GetILGenerator();
        il.BeginExceptionBlock();
        il.Emit(OpCodes.Ldc_I4_1); il.Emit(OpCodes.Ldc_I4_0); il.Emit(OpCodes.Div); il.Emit(OpCodes.Pop);
        il.BeginCatchBlock(typeof(DivideByZeroException)); il.Emit(OpCodes.Pop); il.Emit(OpCodes.Rethrow);
        il.BeginFinallyBlock();
        il.Emit(OpCodes.Ldc_I4, 42); il.Emit(OpCodes.Stsfld, typeof(EmitFixture).GetField(nameof(Shared))!);
        il.EndExceptionBlock(); il.Emit(OpCodes.Ldc_I4_0); il.Emit(OpCodes.Ret);
        try { ((Func<int>)method.CreateDelegate(typeof(Func<int>)))(); }
        catch (DivideByZeroException) { }
        return Shared;
    }
}
