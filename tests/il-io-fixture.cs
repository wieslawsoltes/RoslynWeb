using System;
using System.IO;
using System.Text;
public static class IoFixture {
 public static string Streams() {
  using var stream = new MemoryStream();
  using (var writer = new StreamWriter(stream, Encoding.UTF8, 1024, true)) {
   writer.WriteLine("Hello żółw"); writer.WriteLine(42); writer.Write("tail");
  }
  stream.Position = 0;
  using var reader = new StreamReader(stream);
  return reader.ReadLine() + "|" + reader.ReadLine() + "|" + reader.ReadToEnd();
 }
 public static string Files() {
  Directory.CreateDirectory("/fixture/sub");
  File.WriteAllText("/fixture/first.txt", "first\n");
  File.AppendAllText("/fixture/first.txt", "second\n");
  File.WriteAllBytes("/fixture/sub/bytes.bin", new byte[]{7,8});
  var text = File.ReadAllText("/fixture/first.txt");
  var count = Directory.GetFiles("/fixture", "*", SearchOption.AllDirectories).Length;
  using var file = File.OpenRead("/fixture/sub/bytes.bin");
  int value = file.ReadByte();
  return text + ":" + count.ToString() + ":" + value.ToString();
 }
 public static string Binary() {
  using var stream = new MemoryStream();
  using (var writer = new BinaryWriter(stream, Encoding.UTF8, true)) {
   writer.Write(123456789); writer.Write(9007199254740993L); writer.Write(1.5); writer.Write("Zażółć 😀"); writer.Write(true);
  }
  stream.Position=0;
  using var reader = new BinaryReader(stream);
  return reader.ReadInt32().ToString() + "|" + reader.ReadInt64().ToString() + "|" + reader.ReadDouble().ToString() + "|" + reader.ReadString() + "|" + reader.ReadBoolean().ToString();
 }
 public static int Inheritance() {
  Stream[] streams = new Stream[]{new MemoryStream()};
  TextWriter[] writers = new TextWriter[]{new StringWriter()};
  object encoding = new UTF8Encoding();
  var bytes = ((Encoding)encoding).GetBytes("ok");
  int answer = streams[0] is IDisposable ? 10 : 0;
  writers[0].Write("writer");
  answer += writers[0] is IDisposable ? 20 : 0;
  answer += writers[0].ToString().Length + bytes.Length;
  streams[0].Dispose(); writers[0].Dispose();
  return answer;
 }
 public static int IoException() {
  using var stream = new MemoryStream();
  using var reader = new BinaryReader(stream);
  try { return reader.ReadInt32(); }
  catch (IOException) { return 42; }
 }
 public static int Memory() {
  using var source = new MemoryStream(new byte[]{1,2,3});
  using var destination = new MemoryStream();
  source.CopyTo(destination);
  destination.Seek(1, SeekOrigin.Begin); destination.WriteByte(42);
  destination.Position=0;
  var buffer=new byte[3];destination.Read(buffer,0,buffer.Length);
  return buffer[0]+buffer[1]+buffer[2]-1;
 }
 public static string Text() {
  using var writer = new StringWriter();
  writer.Write(true); writer.WriteLine(42);
  return writer.ToString();
 }
}
