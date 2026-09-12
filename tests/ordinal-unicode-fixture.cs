using System;
using System.Collections.Generic;
public static class OrdinalUnicodeFixture
{
 public static int[] Compare(string a,string b) {
  bool equal=string.Equals(a,b,StringComparison.OrdinalIgnoreCase);
  return new[]{StringComparer.OrdinalIgnoreCase.Compare(a,b),string.Compare(a,b,StringComparison.OrdinalIgnoreCase),equal?1:0,StringComparer.OrdinalIgnoreCase.Equals(a,b)?1:0,
   !equal||a==null||StringComparer.OrdinalIgnoreCase.GetHashCode(a)==StringComparer.OrdinalIgnoreCase.GetHashCode(b)?1:0};
 }
 public static int[] Search(string text,string needle,int start,int count) => new[]{text.IndexOf(needle,start,count,StringComparison.OrdinalIgnoreCase),text.Contains(needle,StringComparison.OrdinalIgnoreCase)?1:0,text.StartsWith(needle,StringComparison.OrdinalIgnoreCase)?1:0,text.EndsWith(needle,StringComparison.OrdinalIgnoreCase)?1:0};
 public static int[] Collections(string a,string b) {
  var dictionary=new Dictionary<string,int>(StringComparer.OrdinalIgnoreCase);dictionary[a]=7;dictionary[b]=9;
  var hash=new HashSet<string>(StringComparer.OrdinalIgnoreCase);hash.Add(a);hash.Add(b);
  var sorted=new SortedSet<string>(StringComparer.OrdinalIgnoreCase);sorted.Add(a);sorted.Add(b);
  var ordered=new SortedDictionary<string,int>(StringComparer.OrdinalIgnoreCase);ordered[a]=7;ordered[b]=9;
  return new[]{dictionary.Count,dictionary[a],dictionary[b],hash.Count,sorted.Count,ordered.Count,ordered[a],ordered[b]};
 }
}
