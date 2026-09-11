using System;
using System.Collections.Generic;

public static class Comprehensive
{
    public static int Checked(int a, int b) => checked(a + b);
    public static long Long() => 9007199254740993L + 2L;
    public static int Array() { int[] a = { 1, 2, 3, 4, 5 }; int sum = 0; foreach (int n in a) sum += n; return sum; }
    public static int ByRef() { int n = 20; Increment(ref n); return n; }
    private static void Increment(ref int n) { n++; }
    public static int Virtual() { Animal a = new Dog(7); return a.Value(); }
    public static int Exceptions(int n) { int result; try { try { result = 100 / n; } catch (DivideByZeroException) { result = 42; } } finally { Counter++; } return result + Counter; }
    public static int Filter(int n) { try { return 100 / n; } catch (Exception e) when (e is DivideByZeroException && n == 0) { return 17; } }
    public static int NestedFinally() { int result = 0; try { result = 3; } finally { try { result += 4; } finally { result += 5; } } return result; }
    public static int CatchInsideFinally() { int result = 0; try { throw new InvalidOperationException(); } finally { try { result = 1 / result; } catch (DivideByZeroException) { Counter += 2; } } }
    public static int List() { var a = new List<int> { 2, 4, 6 }; int sum = 0; foreach (int n in a) sum += n; return sum; }
    public static int Delegate() { Func<int, int> twice = Double; return twice(21); }
    private static int Double(int n) => 2 * n;
    public static string Interpolate(int n) => $"n = {n:D3}";
    public static int Struct() { var p = new Point { X = 3, Y = 4 }; var q = p; q.X = 9; return p.Sum() + q.Sum(); }
    private static int Counter = 1;
}
public class Animal { protected int x; public Animal(int n) { x = n; } public virtual int Value() => x; }
public class Dog : Animal { public Dog(int n) : base(n) { } public override int Value() => 2 * x; }
public struct Point { public int X; public int Y; public int Sum() => X + Y; }
