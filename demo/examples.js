export const examples = [
  { name: 'Hello, browser', description: 'Compile real C# to a portable DLL, then run it without a server.', source: `using System;

public static class Program
{
    public static int Main(string[] args)
    {
        Console.WriteLine("Hello from Roslyn in your browser!");
        Console.WriteLine("C# → MSIL → executable code.");
        Console.WriteLine("Arguments: " + args.Length);
        return 0;
    }
}` },
  { name: 'Algorithms → JavaScript', preferredBackend:'javascript', description: 'Recursion, loops, arrays, integer arithmetic and method calls. Try the JavaScript backend.', source: `using System;

public static class Program
{
    public static int Fibonacci(int n)
        => n < 2 ? n : Fibonacci(n - 1) + Fibonacci(n - 2);

    public static int Main(string[] args)
    {
        int[] values = new int[] { 2, 4, 6, 8, 10 };
        int total = 0;
        for (int i = 0; i < values.Length; i++)
            total += values[i];

        Console.WriteLine("Array total:");
        Console.WriteLine(total);
        Console.WriteLine("Fibonacci(12):");
        Console.WriteLine(Fibonacci(12));
        return 0;
    }
}` },
  { name: 'LINQ & generics', description: 'Execute framework libraries, records, generics and LINQ on .NET WebAssembly.', source: `using System;
using System.Collections.Generic;
using System.Linq;

public record Reading(string Sensor, double Value);

public static class Program
{
    public static void Main()
    {
        var readings = new List<Reading>
        {
            new("Temperature", 21.5),
            new("Pressure", 101.3),
            new("Temperature", 24.8),
            new("Pressure", 100.9)
        };
        foreach (var group in readings.GroupBy(x => x.Sensor))
        {
            var average = group.Average(x => x.Value);
            Console.WriteLine($"{group.Key}: {average:F2}");
        }
    }
}` },
  { name: 'Async & exceptions', description: 'Real async state machines and exception handling through the managed runtime.', source: `using System;
using System.Threading.Tasks;

public static class Program
{
    public static async Task<int> Main()
    {
        Console.WriteLine("Starting asynchronous work…");
        await Task.Delay(30);
        try
        {
            int value = int.Parse("not a number");
        }
        catch (FormatException error)
        {
            Console.WriteLine("Caught: " + error.GetType().Name);
        }
        finally
        {
            Console.WriteLine("Finally block executed.");
        }
        Console.WriteLine("Async work complete.");
        return 0;
    }
}` },
  { name: 'JSON & reflection', description: 'System.Text.Json and reflection with the untrimmed framework.', source: `using System;
using System.Text.Json;

public record Person(string Name, int Age);

public static class Program
{
    public static void Main()
    {
        var person = new Person("Ada", 36);
        var json = JsonSerializer.Serialize(person);
        Console.WriteLine(json);
        var restored = JsonSerializer.Deserialize<Person>(json)!;
        foreach (var property in typeof(Person).GetProperties())
            Console.WriteLine($"{property.Name} = {property.GetValue(restored)}");
    }
}` },
  { name: 'Reusable DLL', description: 'Change output to a library through the API, or export this program as a DLL. Call public static methods with invoke().', source: `using System;

namespace BrowserLibrary;

public static class Calculator
{
    public static double Hypotenuse(double a, double b)
        => Math.Sqrt(a * a + b * b);

    public static long Factorial(int n)
    {
        if (n < 0) throw new ArgumentOutOfRangeException(nameof(n));
        long result = 1;
        for (int i = 2; i <= n; i++) result = checked(result * i);
        return result;
    }
}

public static class Program
{
    public static void Main()
    {
        Console.WriteLine(Calculator.Hypotenuse(3, 4));
        Console.WriteLine(Calculator.Factorial(10));
    }
}` },
  { name: 'NuGet: Newtonsoft.Json', description: 'Restore Newtonsoft.Json version [13.0.3] in the package panel before compiling.', source: `using System;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

public static class Program
{
    public static void Main()
    {
        var document = JObject.Parse("{\\"project\\":\\"Roslyn Browser\\",\\"runsInBrowser\\":true}");
        Console.WriteLine(document["project"]);
        Console.WriteLine(JsonConvert.SerializeObject(new { Ready = true, Answer = 42 }));
    }
}` },
  { name: 'Compiler diagnostics', description: 'Errors include the diagnostic ID, file, line and column. Click an error to jump to the source.', source: `using System;

public static class Program
{
    public static void Main()
    {
        int answer = "forty-two";
        Console.WriteLine(missingName);
    }
}` }
];
