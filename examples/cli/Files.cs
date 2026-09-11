using System;
using System.IO;

string input = File.ReadAllText("input.txt");
File.WriteAllText("output.txt", input.ToUpperInvariant());
Console.WriteLine("Wrote output.txt");
